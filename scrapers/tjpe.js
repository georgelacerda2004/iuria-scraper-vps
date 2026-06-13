// Scraper TJPE — Consulta Jurisprudência Web (sistema próprio, JSF/RichFaces)
// URL: https://www.tjpe.jus.br/consultajurisprudenciaweb/xhtml/consulta/consulta.xhtml
//
// NÃO é eSAJ. É um app JSF + RichFaces (a4j) com fluxo em VÁRIAS etapas, por isso
// precisa de browser real (raw-fetch/CDP brigam com ViewState + a4j lazy-load):
//   1. Abre consulta.xhtml (form "formPesquisaJurisprudencia")
//   2. Preenche "formPesquisaJurisprudencia:inputBuscaSimples" + clica "Pesquisar"
//      (link jsfcljs → POST que navega pra resultado.xhtml)
//   3. resultado.xhtml = "Escolha do Resultado": clica em "Acórdãos"
//      (a4j carrega a lista dentro de #includeContainer, sem nova navegação)
//   4. Lê a lista de acórdãos renderizada e extrai ementa/processo/relator/data.
//
// Fluxo (1-3) mapeado e validado ao vivo (busca "dano moral" → 943 documentos).
// Os SELETORES da etapa 4 (linhas de resultado) são defensivos: o TJPE renderiza
// uma tabela JSF com células label/valor; a 1ª execução na VPS deve confirmar e,
// se preciso, afinar (mesmo processo de validação local do tjsp.js).

const BASE = 'https://www.tjpe.jus.br/consultajurisprudenciaweb/xhtml/consulta';

export async function tjpe(browser, { busca, dataIni, dataFim, limit = 15 }) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  const page = await context.newPage();
  try {
    // 1. Página de busca
    await page.goto(`${BASE}/consulta.xhtml`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForSelector('input[name="formPesquisaJurisprudencia:inputBuscaSimples"]', { timeout: 20000 });

    // 2. Preenche termo (+ datas, se houver) e clica "Pesquisar"
    await page.fill('input[name="formPesquisaJurisprudencia:inputBuscaSimples"]', busca);
    if (dataIni) {
      await page.fill('input[id$="InputDate"]', toDataPtBr(dataIni)).catch(() => {});
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {}),
      page.click('a.form-button:has-text("Pesquisar"), a:has-text("Pesquisar")').catch(() => {}),
    ]);

    // 3. "Escolha do Resultado" → clicar em Acórdãos (a4j carrega no #includeContainer)
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    const escolheu = await page.evaluate(() => {
      const alvo = [...document.querySelectorAll('a, button, label, span, input[type=button], img')]
        .find((e) => /ac[oó]rd[aã]o/i.test((e.textContent || e.value || e.alt || '')));
      if (!alvo) return false;
      (alvo.closest('a, button, label') || alvo).click();
      return true;
    });
    if (!escolheu) {
      // Talvez a busca já tenha caído direto na lista de acórdãos (resultado único)
      // — segue pra extração sem clicar.
    }

    // 4. Aguarda a lista renderizar no container e extrai
    await page.waitForFunction(() => {
      const c = document.querySelector('#includeContainer') || document.querySelector('#conteudo');
      return c && /ementa/i.test(c.innerText || '');
    }, { timeout: 25000 }).catch(() => {});

    const docs = await page.evaluate((max) => {
      const cont = document.querySelector('#includeContainer') || document.querySelector('#conteudo') || document.body;
      // Cada acórdão costuma ser um bloco (tr/div/li) que contém "Ementa" ou um NPU.
      const NPU = /\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/;
      const candidatos = [...cont.querySelectorAll('table tr, li, .resultado, .acordao, .panelResultado, .row, div[class*=result]')]
        .filter((e) => {
          const t = e.textContent || '';
          return (/ementa/i.test(t) || NPU.test(t)) && t.length > 80 && t.length < 8000;
        });
      // Remove blocos aninhados (mantém o mais externo de cada grupo)
      const blocos = candidatos.filter((e) => !candidatos.some((o) => o !== e && o.contains(e)));

      const getLabel = (texto, label) => {
        const re = new RegExp(label + '\\s*:?\\s*([^\\n]{2,140})', 'i');
        const m = texto.match(re);
        return m ? m[1].trim() : '';
      };

      return blocos.slice(0, max).map((b) => {
        const texto = (b.innerText || '').replace(/ /g, ' ').trim();
        // Ementa: textarea, ou o trecho após "Ementa:"
        const ta = b.querySelector('textarea');
        let ementa = ta ? (ta.value || ta.textContent || '').trim() : '';
        if (!ementa) {
          const m = texto.match(/ementa\s*:?\s*([\s\S]{40,4000}?)(?:relator|órg[aã]o|comarca|data\s+d[eo]\s+julg|n[º°]\s*do\s*ac|$)/i);
          ementa = m ? m[1].replace(/\s+/g, ' ').trim() : '';
        }
        const npuM = texto.match(/\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/);
        const link = (b.querySelector('a[href]') || {}).href || `${'https://www.tjpe.jus.br/consultajurisprudenciaweb/xhtml/consulta/consulta.xhtml'}`;
        return {
          numero: npuM ? npuM[0] : '',
          ementa,
          relator: getLabel(texto, 'relator(?:\\(a\\))?'),
          orgao: getLabel(texto, '[óo]rg[ãa]o\\s+julgador') || getLabel(texto, 'c[âa]mara') || '',
          comarca: getLabel(texto, 'comarca'),
          dataJul: getLabel(texto, 'data\\s+d[eo]\\s+julgamento') || getLabel(texto, 'julgamento'),
          classe: getLabel(texto, 'classe'),
          link,
        };
      }).filter((d) => d.ementa && d.ementa.length > 30);
    }, limit);

    return docs.map((d) => ({
      titulo: d.classe ? `${d.classe}${d.numero ? ' — ' + d.numero : ''}` : (d.numero || 'Acórdão TJPE'),
      ementa: d.ementa,
      ementaResumida: d.ementa.slice(0, 280) + (d.ementa.length > 280 ? '…' : ''),
      tribunal: 'TJPE',
      data: normalizarDataPtBr(d.dataJul),
      relator: d.relator,
      orgao: d.orgao + (d.comarca ? ' · ' + d.comarca : ''),
      link: d.link,
      tipo: d.classe || 'Acórdão',
      fonte: 'tribunal-oficial',
    }));
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
