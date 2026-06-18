// Diagnóstico de página crua — diz se foi WAF/Cloudflare ou seletor errado.
// node tests/_diag.js <url> [waitSelector]
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(StealthPlugin());

const url = process.argv[2];
const waitSel = process.argv[3] || null;

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-gpu'],
});
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
});
const page = await ctx.newPage();
let resp = null;
try {
  resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
} catch (e) {
  console.log('GOTO ERROR:', e.message);
}
console.log('HTTP status:', resp ? resp.status() : 'n/a');
console.log('final URL  :', page.url());
console.log('title      :', await page.title().catch(() => '?'));

if (waitSel) {
  const found = await page.waitForSelector(waitSel, { timeout: 15000 }).then(() => true).catch(() => false);
  console.log(`waitSelector "${waitSel}":`, found ? 'FOUND' : 'NOT FOUND');
}

const info = await page.evaluate(() => {
  const body = document.body ? document.body.innerText : '';
  const isCf = /cloudflare|attention required|checking your browser|verify you are human|cf-browser-verification|just a moment/i.test(document.documentElement.outerHTML);
  // conta seletores candidatos comuns
  const counts = {};
  ['.documento', '#idTotal', '.clsNumDocumento', '.paragrafoBRS', '.fundocinza1',
   '.ementaClass2', 'textarea', '.downloadEmenta', '.resultados', '#listadocs',
   'table', 'form', 'iframe'].forEach((s) => { counts[s] = document.querySelectorAll(s).length; });
  return {
    bodyLen: body.length,
    bodyHead: body.slice(0, 600),
    cloudflareLikely: isCf,
    counts,
    htmlLen: document.documentElement.outerHTML.length,
  };
});
console.log('cloudflareLikely:', info.cloudflareLikely);
console.log('bodyLen:', info.bodyLen, 'htmlLen:', info.htmlLen);
console.log('selector counts:', JSON.stringify(info.counts));
console.log('--- body head ---\n', info.bodyHead);

await browser.close();
process.exit(0);
