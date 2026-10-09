// Robô de protocolo no e-SAJ (TJSP). Roda no PC do escritório com o certificado A3 plugado.
// Consome a fila do painel (docs/PROTOCOLO.md): pega o item aprovado, baixa os PDFs, preenche o
// peticionamento inicial seguindo passos-esaj.json, protocola e devolve o número do processo.
//
// Modos:
//   node robo.mjs                -> automático: para e devolve erro (com print) em qualquer passo que falhe
//   node robo.mjs --assistido    -> cada passo que falhar pausa e espera o operador terminar na tela e apertar Enter
//   node robo.mjs --ensaio       -> faz tudo, mas PARA antes de "Protocolar" (salva rascunho no e-SAJ) e devolve
//                                   { ok:false, erro:"ensaio: rascunho salvo" } — é o modo do primeiro teste
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright';

const ARGS = new Set(process.argv.slice(2));
const ASSISTIDO = ARGS.has('--assistido'), ENSAIO = ARGS.has('--ensaio'), UMA_VEZ = ARGS.has('--uma-vez');
const CFG = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const PASSOS = JSON.parse(fs.readFileSync(new URL('./passos-esaj.json', import.meta.url), 'utf8')).passos;
const RE_NUMERO = /\d{7}-\d{2}\.\d{4}\.8\.26\.\d{4}/;

const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);
const api = async (p, opt = {}) => {
  const r = await fetch(CFG.painel_url + p, { ...opt, headers: { 'x-painel': CFG.painel_senha, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${j.erro || r.status}`);
  return j;
};
const perguntar = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a); }); });

// "{partes.ativo[0].nome}" -> valor do item; "{esaj.portal}" -> config.
function valor(expr, item) {
  if (typeof expr !== 'string') return expr;
  return expr.replace(/\{([^}]+)\}/g, (_, caminho) => {
    const raiz = caminho.startsWith('esaj.') ? CFG : item;
    const v = caminho.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => (o == null ? undefined : o[k]), raiz);
    return v == null ? '' : String(v);
  });
}

async function baixar(item) {
  const pasta = path.join(CFG.pasta_downloads, item.distribuicao_id.slice(0, 8));
  fs.mkdirSync(pasta, { recursive: true });
  const arquivos = [];
  for (const a of item.arquivos) {
    const destino = path.join(pasta, a.nome);
    const r = await fetch(a.url);
    if (!r.ok) throw new Error(`download ${a.nome}: HTTP ${r.status}`);
    fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
    arquivos.push({ ...a, caminho: destino });
  }
  log(`${arquivos.length} PDF(s) em ${pasta}`);
  return arquivos;
}

async function print(page, nome) {
  fs.mkdirSync(CFG.pasta_prints, { recursive: true });
  const p = path.join(CFG.pasta_prints, `${Date.now()}-${nome}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  return p;
}

// Executa um passo; devolve true se deu certo. Lança erro só quando é obrigatório e não há operador.
async function executar(page, passo, item, arquivos) {
  const alvo = valor(passo.alvo, item), v = valor(passo.valor, item);
  const loc = alvo?.startsWith('label=') ? page.getByLabel(alvo.slice(6), { exact: false }) : alvo?.startsWith('text=') ? page.getByText(alvo.slice(5).startsWith('/') ? new RegExp(alvo.slice(6, -1)) : alvo.slice(5), { exact: false }) : alvo ? page.locator(alvo) : null;
  switch (passo.acao) {
    case 'ir': await page.goto(alvo, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return true;
    case 'esperar': await loc.first().waitFor({ timeout: 120_000 }); return true;
    case 'clicar': await loc.first().click({ timeout: 15_000 }); return true;
    case 'digitar': await loc.first().fill(v, { timeout: 15_000 }); return true;
    case 'marcar': { const el = loc.first(); const quer = String(v) === 'true'; if ((await el.isChecked().catch(() => false)) !== quer) await el.click({ timeout: 15_000 }); return true; }
    case 'selecionar': {
      const el = loc.first();
      try { await el.selectOption({ label: v }, { timeout: 15_000 }); return true; }
      catch { const opts = await el.locator('option').allTextContents().catch(() => []); const parecido = opts.find(o => o.toLowerCase().includes(v.toLowerCase().split(' ')[0])); if (!parecido) throw new Error(`opção "${v}" não encontrada em ${alvo}`); await el.selectOption({ label: parecido }); log(`  ~ usei "${parecido}" para "${v}"`); return true; }
    }
    case 'anexar': await loc.first().setInputFiles(arquivos.map(a => a.caminho)); return true;
    case 'conferir': log('  conferência:', passo.nota); if (ENSAIO) throw Object.assign(new Error('ensaio: parou antes de protocolar (salve o rascunho na tela)'), { ensaio: true }); return true;
    case 'pausar': if (!ASSISTIDO && !ENSAIO) throw new Error(`passo manual pendente: ${passo.nota}`); await perguntar(`\n>>> ${passo.nota}\n>>> Faça na tela e aperte Enter para continuar... `); return true;
    default: throw new Error(`ação desconhecida: ${passo.acao}`);
  }
}

async function protocolar(item) {
  const arquivos = await baixar(item);
  const ctx = await chromium.launchPersistentContext(CFG.perfil_chrome, { channel: 'chrome', headless: false, viewport: null, acceptDownloads: true, args: ['--start-maximized'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  const trilha = [];
  try {
    for (const [i, passo] of PASSOS.entries()) {
      const rotulo = `${i + 1}/${PASSOS.length} ${passo.acao} ${passo.alvo || ''}`;
      log(rotulo);
      try { await executar(page, passo, item, arquivos); trilha.push({ passo: rotulo, ok: true }); }
      catch (e) {
        if (e.ensaio) throw e;
        trilha.push({ passo: rotulo, ok: false, erro: e.message });
        if (ASSISTIDO) { await print(page, `passo-${i + 1}`); await perguntar(`\n!!! Falhou: ${e.message}\n>>> Termine este passo na tela e aperte Enter... `); continue; }
        if (passo.obrigatorio !== false && passo.acao !== 'marcar') throw e;
        log('  (opcional, seguindo)');
      }
    }
    // Número do processo: na tela do recibo.
    const texto = await page.locator('body').innerText().catch(() => '');
    const numero = (texto.match(RE_NUMERO) || [])[0];
    if (!numero) throw new Error('protocolou? não achei o número do processo na tela');
    const recibo = path.join(CFG.pasta_prints, `${Date.now()}-recibo-${numero}.pdf`);
    await page.pdf({ path: recibo, format: 'A4' }).catch(() => {});
    const recibo_base64 = fs.existsSync(recibo) ? fs.readFileSync(recibo).toString('base64') : undefined;
    return { ok: true, numero_processo: numero, recibo_base64, recibo_nome: `recibo-${numero}.pdf`, detalhes: { trilha, modo: ASSISTIDO ? 'assistido' : 'automatico' } };
  } catch (e) {
    const tela = await print(page, 'erro');
    const tela_base64 = fs.existsSync(tela) ? fs.readFileSync(tela).toString('base64') : undefined;
    return { ok: false, erro: e.message, tela_base64, detalhes: { trilha, modo: ENSAIO ? 'ensaio' : ASSISTIDO ? 'assistido' : 'automatico' } };
  } finally {
    if (!ASSISTIDO && !ENSAIO) await ctx.close(); else log('navegador fica aberto para você conferir; feche quando terminar.');
  }
}

async function ciclo() {
  const { itens } = await api('/fila');
  const item = itens.find(i => i.status === 'aprovada');
  if (!item) { log('fila vazia'); return false; }
  log(`item ${item.distribuicao_id.slice(0, 8)} — ${item.cliente?.nome} — ${item.classe} — R$ ${item.valor_causa}`);
  if (!ENSAIO) await api(`/fila/${item.distribuicao_id}/pegar`, { method: 'POST', body: JSON.stringify({ robo: CFG.robo }) });
  const resultado = await protocolar(item);
  log(resultado.ok ? `PROTOCOLADO ${resultado.numero_processo}` : `PAROU: ${resultado.erro}`);
  if (ENSAIO) { log('(ensaio: nada foi enviado ao painel)'); return true; }
  await api(`/fila/${item.distribuicao_id}/resultado`, { method: 'POST', body: JSON.stringify(resultado) });
  return true;
}

log(`robô de protocolo — modo ${ENSAIO ? 'ENSAIO' : ASSISTIDO ? 'ASSISTIDO' : 'AUTOMÁTICO'}`);
for (;;) {
  try { await ciclo(); } catch (e) { log('erro no ciclo:', e.message); }
  if (UMA_VEZ || ENSAIO || ASSISTIDO) break;
  await new Promise(r => setTimeout(r, (CFG.intervalo_segundos || 60) * 1000));
}
