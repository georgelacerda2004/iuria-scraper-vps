// Harness de validação LOCAL dos scrapers (Fase 2).
//
// Reproduz EXATAMENTE o setup de browser/stealth do server.js, mas sem
// Express/Redis — só lança o browser, chama o scraper passado e imprime
// um relatório com prova (ementa real ou bloqueio documentado).
//
// Uso:
//   node tests/_harness.js <tribunal> "<termo>" [headful]
//   node tests/test-stj.js          (wrapper)
//   node tests/test-tjsp.js         (wrapper)
//
// "headful" no 3º arg abre o browser visível (debug). Default: headless.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

const SCRAPERS = {
  stj: () => import('../scrapers/stj.js').then((m) => m.stj),
  tjsp: () => import('../scrapers/tjsp.js').then((m) => m.tjsp),
  stf: () => import('../scrapers/stf.js').then((m) => m.stf),
  tst: () => import('../scrapers/tst.js').then((m) => m.tst),
  tjpe: () => import('../scrapers/tjpe.js').then((m) => m.tjpe),
};

export async function run(tribunal, busca, { headful = false, limit = 8 } = {}) {
  const loader = SCRAPERS[tribunal];
  if (!loader) {
    console.error(`Tribunal desconhecido: ${tribunal}. Use: ${Object.keys(SCRAPERS).join(', ')}`);
    process.exit(2);
  }
  const scraper = await loader();

  console.log(`\n===== ${tribunal.toUpperCase()} | busca: "${busca}" | limit=${limit} | headful=${headful} =====`);
  const t0 = Date.now();
  const browser = await chromium.launch({
    headless: !headful,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
    ],
  });

  let resultados = [];
  let erro = null;
  try {
    resultados = await scraper(browser, { busca, limit });
  } catch (e) {
    erro = e;
  } finally {
    await browser.close();
  }
  const ms = Date.now() - t0;

  if (erro) {
    console.log(`\n[RESULTADO] ERRO após ${ms}ms`);
    console.log(`  message: ${erro.message}`);
    console.log(erro.stack?.split('\n').slice(0, 4).join('\n'));
    return { tribunal, busca, ok: false, total: 0, ms, erro: erro.message };
  }

  console.log(`\n[RESULTADO] ${resultados.length} acórdão(s) em ${ms}ms`);
  if (resultados.length === 0) {
    console.log('  VAZIO — pode ser WAF/bloqueio ou seletor desatualizado (ver diagnóstico do scraper).');
    return { tribunal, busca, ok: false, total: 0, ms };
  }

  // Mostra prova: 1º resultado completo + ementas dos demais resumidas
  const r0 = resultados[0];
  console.log('\n--- PROVA (1º resultado) ---');
  console.log('  titulo :', r0.titulo);
  console.log('  relator:', r0.relator || '(vazio)');
  console.log('  orgao  :', r0.orgao || '(vazio)');
  console.log('  data   :', r0.data || '(vazio)');
  console.log('  link   :', r0.link);
  console.log('  tipo   :', r0.tipo);
  console.log('  EMENTA (trecho 400 chars):');
  console.log('  ' + (r0.ementa || '').slice(0, 400).replace(/\n/g, '\n  '));
  console.log(`  [ementa total: ${(r0.ementa || '').length} chars]`);

  console.log('\n--- demais ---');
  resultados.slice(1).forEach((r, i) => {
    console.log(`  #${i + 2} ${r.titulo} | rel:${r.relator || '-'} | ementa:${(r.ementa || '').length}ch`);
  });

  const comEmenta = resultados.filter((r) => (r.ementa || '').length > 60).length;
  console.log(`\n[VEREDITO] ${comEmenta}/${resultados.length} com ementa textual (>60 chars).`);
  return { tribunal, busca, ok: comEmenta > 0, total: resultados.length, comEmenta, ms };
}

// CLI direto
const isMain = process.argv[1] && process.argv[1].endsWith('_harness.js');
if (isMain) {
  const [, , tribunal, busca, mode] = process.argv;
  if (!tribunal || !busca) {
    console.error('Uso: node tests/_harness.js <tribunal> "<termo>" [headful]');
    process.exit(1);
  }
  run(tribunal, busca, { headful: mode === 'headful' })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => {
      console.error('harness fatal:', e);
      process.exit(3);
    });
}
