// Scraper TJSP — eSAJ Consulta de Jurisprudência (cjsg)
// URL: https://esaj.tjsp.jus.br/cjsg/consultaCompleta.do
//
// O eSAJ é stateful (precisa visitar a página de busca primeiro pra pegar
// session cookie/csrf), então fluxo:
//   1. Navega pra /cjsg/consultaCompleta.do (form)
//   2. Preenche campo dados.buscaInteiroTeor + submete
//   3. Aguarda /cjsg/resultadoCompleta.do carregar
//   4. Extrai blocos .fundocinza1 (cada acórdão)
//
// Cada bloco contém:
//   - .downloadEmenta (número do processo + link cdAcordao)
//   - <textarea> (ementa textual)
//   - .ementaClass2 (linhas chave:valor: Relator, Órgão Julgador, Data, etc)
//   - .assuntoClasse (classe + assunto)

export async function tjsp(browser, { busca, dataIni, dataFim, limit = 15 }) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  const page = await context.newPage();
  try {
    // 1. Carrega página de busca (estabelece sessão)
    await page.goto('https://esaj.tjsp.jus.br/cjsg/consultaCompleta.do', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2. Preenche termo de busca e submete
    await page.waitForSelector('input[name="dados.buscaInteiroTeor"]', { timeout: 15000 });
    await page.fill('input[name="dados.buscaInteiroTeor"]', busca);
    if (dataIni) {
      const di = toDataPtBr(dataIni);
      await page.fill('input[name="dados.dtJulgamentoInicio"]', di).catch(() => {});
    }
    if (dataFim) {
      const df = toDataPtBr(dataFim);
      await page.fill('input[name="dados.dtJulgamentoFim"]', df).catch(() => {});
    }
    // Garante o tipo "Acórdãos" marcado (checkbox tipoDecisaoSelecionados=A; já vem
    // checked por padrão, mas reforçamos por robustez). Origem 2º grau (T) idem.
    await page.check('#Acheckbox').catch(() => {});
    await page.check('#origem2grau').catch(() => {});

    // 3. Submete e aguarda resultado.
    // IMPORTANTE: o botão de pesquisa é #pbSubmit (input[type=submit]). Não usar
    // um seletor genérico 'button[type=submit]' — a página tem outros botões submit
    // (modal "Instalar", botão beta oculto) que vêm ANTES no DOM e quebram o envio.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.click('#pbSubmit').catch(() => {}),
    ]);

    // Fallback: submete o form pelo nome real (consultaCompletaForm) se não navegou.
    if (!page.url().includes('resultadoCompleta')) {
      await page.evaluate(() => {
        const f = document.forms['consultaCompletaForm']
          || document.querySelector('form[name="consultaCompletaForm"], form[action*="resultadoCompleta"]')
          || document.forms[0];
        if (f) f.submit();
      });
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    }

    // 4. Aguarda a lista OU o gate de captcha aparecer (o que vier primeiro).
    await page.waitForFunction(() => {
      return document.querySelectorAll('.fundocinza1, table.fundocinza1').length > 0
        || document.querySelector('.g-recaptcha, [data-sitekey], iframe[src*=recaptcha]')
        || /n[ãa]o foram encontrad|nenhum registro|nenhum resultado/i.test(document.body.innerText);
    }, { timeout: 25000 }).catch(() => {});

    // O eSAJ cjsg detecta automação e, em vez da lista de acórdãos, serve a página
    // de resultado (resultadoCompleta.do) com um reCAPTCHA gateando os dados +
    // ZERO blocos .fundocinza1. Na página de resultado, um nó reCAPTCHA presente
    // junto com zero acórdãos é gate inequívoco. Falha EXPLICITAMENTE.
    const bloqueio = await page.evaluate(() => {
      const temResultado = document.querySelectorAll('.fundocinza1, table.fundocinza1').length > 0;
      if (temResultado) return null;
      const semRegistro = /n[ãa]o foram encontrad|nenhum registro|nenhum resultado/i.test(document.body.innerText);
      if (semRegistro) return 'sem-registros';
      const naPaginaResultado = /resultadoCompleta\.do/i.test(location.href);
      const recNode = document.querySelector('.g-recaptcha, [data-sitekey], iframe[src*=recaptcha]');
      if (naPaginaResultado && recNode) return 'recaptcha';
      return 'vazio-desconhecido';
    });
    if (bloqueio === 'recaptcha') {
      throw new Error(
        `TJSP eSAJ cjsg gateou os resultados com reCAPTCHA em ${page.url()} ` +
        '(sessão detectada como automação). Sem desafio resolvido a lista de acórdãos ' +
        'não renderiza — requer VPS com IP limpo (Fase 3) ou solver.',
      );
    }
    if (bloqueio === 'sem-registros') {
      return []; // busca legítima sem resultados
    }

    // 5. Extrai cada acórdão
    const docs = await page.evaluate((max) => {
      const blocos = Array.from(document.querySelectorAll('table.fundocinza1, .fundocinza1'));
      return blocos.slice(0, max).map((bloco) => {
        // Número do processo
        const numNode = bloco.querySelector('.downloadEmenta');
        const numero = (numNode?.textContent || '').trim();

        // cdAcordao pro link (no href ou data-attr)
        let cdAcordao = '';
        const linkNode = bloco.querySelector('a[href*="cdAcordao"]');
        if (linkNode) {
          const m = linkNode.href.match(/cdAcordao=(\d+)/);
          if (m) cdAcordao = m[1];
        }

        // Ementa: <textarea>
        const ementaNode = bloco.querySelector('textarea');
        const ementa = (ementaNode?.value || ementaNode?.textContent || '').trim();

        // Metadados chave:valor em .ementaClass2
        const metas = Array.from(bloco.querySelectorAll('.ementaClass2'));
        const dados = {};
        for (const m of metas) {
          const txt = m.textContent.trim();
          const idx = txt.indexOf(':');
          if (idx > 0) {
            const chave = txt.slice(0, idx).trim().toLowerCase();
            const valor = txt.slice(idx + 1).trim();
            dados[chave] = valor;
          }
        }

        // Classe / Assunto
        const classeNode = bloco.querySelector('.assuntoClasse');
        const classe = (classeNode?.textContent || '').trim();

        return { numero, cdAcordao, ementa, dados, classe };
      }).filter(d => d.ementa && d.ementa.length > 30);
    }, limit);

    return docs.map((d) => {
      const relator = d.dados['relator(a)'] || d.dados['relatora'] || d.dados['relator'] || '';
      const orgao = d.dados['órgão julgador'] || d.dados['orgão julgador'] || d.dados['orgao julgador'] || 'TJSP';
      const comarca = d.dados['comarca'] || '';
      const dataJul = d.dados['data do julgamento'] || d.dados['data de julgamento'] || d.dados['data julgamento'] || '';
      const link = d.cdAcordao
        ? `https://esaj.tjsp.jus.br/cjsg/getArquivo.do?cdAcordao=${d.cdAcordao}&cdForo=0`
        : 'https://esaj.tjsp.jus.br/cjsg/consultaCompleta.do';
      const titulo = d.classe
        ? `${d.classe}${d.numero ? ' — ' + d.numero : ''}`
        : (d.numero || 'Acórdão TJSP');
      return {
        titulo,
        ementa: d.ementa,
        ementaResumida: d.ementa.slice(0, 280) + (d.ementa.length > 280 ? '…' : ''),
        tribunal: 'TJSP',
        data: normalizarDataPtBr(dataJul),
        relator,
        orgao: orgao + (comarca ? ' · ' + comarca : ''),
        link,
        tipo: d.classe || 'Acórdão',
        fonte: 'tribunal-oficial',
      };
    });
  } finally {
    await context.close();
  }
}

function normalizarDataPtBr(s) {
  if (!s) return '';
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

function toDataPtBr(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}
