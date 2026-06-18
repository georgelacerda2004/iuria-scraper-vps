// Scraper STJ — SCON (Sistema de Consulta da Jurisprudência)
// URL: https://scon.stj.jus.br/SCON/pesquisar.jsp?b=ACOR&livre=TERMO
//
// O SCON renderiza HTML server-side mas tem Cloudflare na frente. Com Playwright
// real, o desafio JS roda automaticamente e a página carrega normalmente.
//
// Estrutura dos resultados (cada acórdão):
//   <div class="documento">
//     <div class="paragrafoBRS"> ... vários paragrafos chave:valor
//   </div>
//
// Campos extraídos: numero do processo, ementa, relator, órgão julgador,
// data julgamento, data publicação.

export async function stj(browser, { busca, limit = 15 }) {
  const url = `https://scon.stj.jus.br/SCON/pesquisar.jsp?b=ACOR&livre=${encodeURIComponent(busca)}&processo=&tipo_visualizacao=null`;
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    const status0 = resp ? resp.status() : 0;

    // O SCON está atrás do Cloudflare/CSID. Quando há desafio JS, a página inicial
    // vem com HTTP 403 + interstitial "Verificação automática em andamento".
    // Damos tempo (até ~25s) pro challenge resolver sozinho (stealth costuma passar
    // em IP de datacenter "limpo"; em IP residencial/edge geralmente FALHA — esse é
    // o motivo de existir a VPS na Fase 3).
    const challenged = await isChallenge(page);
    if (challenged) {
      await page.waitForFunction(
        () => !/Verifica[çc][ãa]o autom[áa]tica|just a moment|cf-browser-verification|__cf_chl/i.test(document.documentElement.outerHTML),
        { timeout: 25000 },
      ).catch(() => {});
    }

    // Se ainda estiver bloqueado, falha EXPLICITAMENTE (não retorna vazio silencioso).
    if (await isChallenge(page)) {
      const rayMatch = (await page.content()).match(/RAY\s*\(?ID\)?[:\s]*([0-9a-f]+)/i);
      throw new Error(
        `STJ bloqueado por Cloudflare/CSID (status inicial ${status0}` +
        (rayMatch ? `, RayID ${rayMatch[1]}` : '') +
        '). Desafio anti-bot não resolveu deste IP — requer VPS (Fase 3).',
      );
    }

    // Aguarda listagem carregar
    await page.waitForSelector('.documento, #idTotal, .clsNumDocumento', { timeout: 25000 }).catch(() => {});

    // Extrai todos os documentos
    const docs = await page.evaluate((max) => {
      const nodes = Array.from(document.querySelectorAll('.documento'));
      return nodes.slice(0, max).map((node) => {
        // Cada paragrafo é um campo: <div class="paragrafoBRS"><div class="docTitulo">Ementa</div><div class="docTexto">TEXTO</div></div>
        const paragrafos = Array.from(node.querySelectorAll('.paragrafoBRS'));
        const dados = {};
        for (const p of paragrafos) {
          const titulo = (p.querySelector('.docTitulo')?.textContent || '').trim();
          const texto = (p.querySelector('.docTexto')?.textContent || '').trim();
          if (titulo && texto) dados[titulo] = texto;
        }
        return dados;
      });
    }, limit);

    return docs.map((d) => {
      const titulo = d['Processo'] || d['Acórdão'] || d['Recurso Especial'] || d['Habeas Corpus'] || 'Acórdão STJ';
      const ementa = d['Ementa'] || d['EMENTA'] || '';
      const relator = d['Relator'] || d['Relatora'] || d['Ministro'] || d['Ministra'] || '';
      const orgao = d['Órgão Julgador'] || d['Orgão Julgador'] || d['Turma'] || 'STJ';
      const dataJul = d['Data do Julgamento'] || d['Data Julgamento'] || '';
      const dataPub = d['Data da Publicação/Fonte'] || d['Data da Publicação'] || d['Publicação'] || '';
      const numMatch = titulo.match(/(\d[\d.\-\/]+)/);
      const numero = numMatch ? numMatch[1].replace(/[^\d]/g, '') : '';
      const link = numero
        ? `https://scon.stj.jus.br/SCON/pesquisar.jsp?b=ACOR&processo=${numero}&tipo_visualizacao=null`
        : `https://scon.stj.jus.br/SCON/pesquisar.jsp?b=ACOR&livre=${encodeURIComponent(busca)}`;
      return {
        titulo,
        ementa,
        ementaResumida: ementa.slice(0, 280) + (ementa.length > 280 ? '…' : ''),
        tribunal: 'STJ',
        data: normalizarDataPtBr(dataJul || dataPub),
        relator,
        orgao,
        link,
        tipo: 'Acórdão',
        fonte: 'tribunal-oficial',
      };
    }).filter((a) => a.ementa.length > 30);
  } finally {
    await context.close();
  }
}

// Detecta o interstitial do Cloudflare/CSID do STJ.
async function isChallenge(page) {
  return page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    return /Verifica[çc][ãa]o autom[áa]tica em andamento|just a moment|cf-browser-verification|__cf_chl|Coordenadoria de Seguran[çc]a e Defesa Cibern[ée]tica/i.test(html)
      && !document.querySelector('.documento');
  }).catch(() => false);
}

function normalizarDataPtBr(s) {
  if (!s) return '';
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}
