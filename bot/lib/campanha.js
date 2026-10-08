// Robô de campanha (Meta Marketing API, Graph v21): cria o rascunho pausado, lê resultados,
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const AQUI = path.dirname(fileURLToPath(import.meta.url));
// cruza com o CRM (leads qualificados e pagos por anúncio) e aplica regras. Nunca ativa nada sozinho:
// ativar é clique do George no Gerenciador (ou comando explícito).
import { db } from './db.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const cfg = () => ({ token: process.env.META_ADS_TOKEN, conta: process.env.META_AD_ACCOUNT_ID, pagina: process.env.META_PAGE_ID });

async function graph(path, { method = 'GET', params = {}, body } = {}) {
  const { token } = cfg();
  if (!token) throw new Error('[campanha] META_ADS_TOKEN ausente');
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  url.searchParams.set('access_token', token);
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`[campanha] ${method} ${path}: ${j?.error?.message || `HTTP ${r.status}`}`);
  return j;
}

// Regras padrão (editáveis por variável de ambiente). Valores em reais.
export function regras() {
  return {
    orcamentoDiario: Number(process.env.CAMPANHA_ORCAMENTO_DIA || 100),
    gastoMinimoParaJulgar: Number(process.env.CAMPANHA_GASTO_MINIMO || 60),       // só julga um anúncio depois de gastar isso
    tetoCustoConversa: Number(process.env.CAMPANHA_TETO_CONVERSA || 25),           // R$ por conversa iniciada
    tetoCustoLeadQualificado: Number(process.env.CAMPANHA_TETO_QUALIFICADO || 120), // R$ por lead que passou da triagem
    janelaDias: Number(process.env.CAMPANHA_JANELA_DIAS || 7),
  };
}

// --- leitura ---
export async function insightsPorAnuncio({ dias = 7 } = {}) {
  const { conta } = cfg();
  // Os presets "last_Nd" do Meta excluem o dia de hoje; usamos um intervalo explícito (fuso da conta, Brasília) que inclui hoje.
  const dia = (offset) => new Date(Date.now() - offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const time_range = { since: dia(Math.max(0, dias - 1)), until: dia(0) };
  const date_preset = `${time_range.since}..${time_range.until}`;
  const j = await graph(`act_${conta}/insights`, { params: { level: 'ad', fields: 'ad_id,ad_name,adset_id,campaign_id,spend,impressions,clicks,actions', time_range, limit: 200 } });
  if (!(j.data || []).length) {
    // Diagnóstico (sem segredos): a conta responde mas sem linhas; quantos anúncios o token enxerga?
    const ads = await graph(`act_${conta}/ads`, { params: { fields: 'id,effective_status', limit: 50 } }).catch(e => ({ erro: e.message }));
    console.warn(`[campanha] insights vazios em act_${conta} (${date_preset}); anúncios visíveis: ${ads.erro ? 'erro ' + ads.erro : (ads.data || []).length}; resposta: ${JSON.stringify(j).slice(0, 300)}`);
  }
  return (j.data || []).map(r => {
    const conv = (r.actions || []).find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d');
    return { ad_id: r.ad_id, ad_name: r.ad_name, adset_id: r.adset_id, campaign_id: r.campaign_id, gasto: Number(r.spend || 0), impressoes: Number(r.impressions || 0), cliques: Number(r.clicks || 0), conversas: Number(conv?.value || 0) };
  });
}

// Leads por anúncio vindos do CRM do robô (referral.source_id = ad_id).
export async function leadsPorAnuncio({ dias = 7 } = {}) {
  const s = db();
  if (!s) return {};
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const { data } = await s.from('se_conversas').select('ad_id,etapa,pago_em').eq('origem', 'ads_whatsapp').gte('criado_em', desde);
  const out = {};
  for (const c of data || []) {
    if (!c.ad_id) continue;
    out[c.ad_id] ??= { leads: 0, qualificados: 0, pagos: 0 };
    out[c.ad_id].leads++;
    if (['viavel', 'docs', 'pagamento_assinatura', 'cliente'].includes(c.etapa)) out[c.ad_id].qualificados++;
    if (c.pago_em) out[c.ad_id].pagos++;
  }
  return out;
}

// --- decisão (pura, testável) ---
export function decidir(insights, leads, R = regras()) {
  const decisoes = [];
  for (const a of insights) {
    const l = leads[a.ad_id] || { leads: 0, qualificados: 0, pagos: 0 };
    const custoConversa = a.conversas ? a.gasto / a.conversas : null;
    const custoQualificado = l.qualificados ? a.gasto / l.qualificados : null;
    let acao = 'manter', motivo = '';
    if (a.gasto >= R.gastoMinimoParaJulgar) {
      if (a.conversas === 0) { acao = 'pausar'; motivo = `gastou R$ ${a.gasto.toFixed(0)} sem nenhuma conversa`; }
      else if (custoConversa > R.tetoCustoConversa && l.qualificados === 0) { acao = 'pausar'; motivo = `R$ ${custoConversa.toFixed(0)} por conversa (teto R$ ${R.tetoCustoConversa}) e nenhum lead qualificado`; }
      else if (custoQualificado !== null && custoQualificado > R.tetoCustoLeadQualificado) { acao = 'pausar'; motivo = `R$ ${custoQualificado.toFixed(0)} por lead qualificado (teto R$ ${R.tetoCustoLeadQualificado})`; }
      else if (l.pagos > 0) { acao = 'destacar'; motivo = `${l.pagos} cliente(s) pago(s)`; }
    }
    decisoes.push({ ...a, ...l, custoConversa, custoQualificado, acao, motivo });
  }
  return decisoes;
}

export async function aplicar(decisoes, { dryRun = true } = {}) {
  const feitas = [];
  for (const d of decisoes.filter(x => x.acao === 'pausar')) {
    if (!dryRun) await graph(d.ad_id, { method: 'POST', body: { status: 'PAUSED' } });
    feitas.push(`${dryRun ? '[simulação] ' : ''}pausado "${d.ad_name}": ${d.motivo}`);
  }
  return feitas;
}

export function relatorio(decisoes, R = regras()) {
  const tot = decisoes.reduce((s, d) => ({ gasto: s.gasto + d.gasto, conversas: s.conversas + d.conversas, leads: s.leads + d.leads, qual: s.qual + d.qualificados, pagos: s.pagos + d.pagos }), { gasto: 0, conversas: 0, leads: 0, qual: 0, pagos: 0 });
  const l = [`CAMPANHA SUPERENDIVIDAMENTO — últimos ${R.janelaDias} dias`, `Gasto R$ ${tot.gasto.toFixed(2)} · ${tot.conversas} conversas · ${tot.qual} qualificados · ${tot.pagos} pagos`];
  if (tot.conversas) l.push(`Custo por conversa R$ ${(tot.gasto / tot.conversas).toFixed(2)}`);
  if (tot.qual) l.push(`Custo por lead qualificado R$ ${(tot.gasto / tot.qual).toFixed(2)}`);
  if (tot.pagos) l.push(`Custo por cliente pago R$ ${(tot.gasto / tot.pagos).toFixed(2)} (entrada R$ ${Number(process.env.HONORARIOS_ENTRADA || 500)})`);
  for (const d of decisoes) l.push(`• ${d.ad_name}: R$ ${d.gasto.toFixed(0)} · ${d.conversas} conv · ${d.qualificados} qual · ${d.pagos} pagos${d.acao !== 'manter' ? ` → ${d.acao.toUpperCase()} (${d.motivo})` : ''}`);
  return l.join('\n');
}

// --- criação do rascunho (tudo PAUSADO) ---
// Chave da região "São Paulo (state)" na API da Meta, confirmada por leitura do ad set em 08/10/2026.
export const REGIAO_SAO_PAULO = '460';

async function regiaoSaoPaulo() {
  try {
    const j = await graph('search', { params: { type: 'adgeolocation', q: 'São Paulo', location_types: ['region'], country_code: 'BR' } });
    const r = (j.data || []).find(x => /s[aã]o paulo/i.test(x.name));
    if (r?.key) return String(r.key);
  } catch (e) { console.warn('[campanha] busca da região falhou, usando chave conhecida:', e.message); }
  return REGIAO_SAO_PAULO;
}

// Textos informativos, dentro do Provimento 205/2021: sem valores, sem promessa, sem "clique e reduza".
export const CRIATIVOS_PADRAO = [
  { nome: 'Informativo 1 — a lei existe', imagem: 'anuncios/01-a-lei-existe-feed.png', texto: 'Você sabia que existe uma lei para quem não consegue mais pagar as dívidas sem comprometer o básico da família? É a Lei do Superendividamento (Lei 14.181/2021). Ela permite reunir todos os credores numa única negociação na Justiça. Tire suas dúvidas com nosso assistente.', titulo: 'Lei do Superendividamento: o que ela permite' },
  { nome: 'Informativo 2 — mínimo existencial', imagem: 'anuncios/02-minimo-existencial-feed.png', texto: 'A lei garante que uma parte da sua renda fique protegida para despesas básicas, o chamado mínimo existencial. Se as parcelas estão tomando quase tudo, vale entender como funciona. Converse com nosso assistente e saiba se o seu caso se enquadra.', titulo: 'Quando as parcelas tomam quase toda a renda' },
  { nome: 'Informativo 3 — plano de até 5 anos', imagem: 'anuncios/03-plano-5-anos-feed.png', texto: 'Pela Lei 14.181/2021, o consumidor de boa-fé pode pedir ao juiz um plano para pagar as dívidas de consumo em até 5 anos, com todos os credores na mesma mesa. Entenda o que entra e o que não entra. Fale com nosso assistente.', titulo: 'Um plano para todas as dívidas, na mesma mesa' },
];

// Sobe a imagem do cartão para a biblioteca da conta e devolve o image_hash.
async function subirImagem(conta, arquivo) {
  const bytes = (await readFile(path.join(AQUI, '..', arquivo))).toString('base64');
  const j = await graph(`act_${conta}/adimages`, { method: 'POST', body: { bytes } });
  const img = Object.values(j.images || {})[0];
  if (!img?.hash) throw new Error(`[campanha] upload da imagem falhou: ${arquivo}`);
  return img.hash;
}

export async function criarRascunho({ criativos = CRIATIVOS_PADRAO, imagens = [], mensagemBoasVindas } = {}) {
  const { conta, pagina } = cfg();
  if (!conta || !pagina) throw new Error('[campanha] META_AD_ACCOUNT_ID e META_PAGE_ID são obrigatórios');
  const R = regras();
  const camp = await graph(`act_${conta}/campaigns`, { method: 'POST', body: { name: 'Superendividamento — Click-to-WhatsApp', objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED', special_ad_categories: [], daily_budget: Math.round(R.orcamentoDiario * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP' } });
  const regiao = await regiaoSaoPaulo();
  const adset = await graph(`act_${conta}/adsets`, { method: 'POST', body: {
    name: 'SP · 18+ · WhatsApp', campaign_id: camp.id, status: 'PAUSED', destination_type: 'WHATSAPP', optimization_goal: 'CONVERSATIONS', billing_event: 'IMPRESSIONS',
    promoted_object: { page_id: pagina }, targeting: { geo_locations: { regions: [{ key: regiao }] }, age_min: 18, targeting_automation: { advantage_audience: 1 } },
  } });
  const ads = [];
  for (let i = 0; i < criativos.length; i++) {
    const c = criativos[i];
    const link_data = { message: c.texto, name: c.titulo, link: 'https://api.whatsapp.com/send', call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } };
    if (imagens[i]) link_data.picture = imagens[i];
    else if (c.imagem) link_data.image_hash = await subirImagem(conta, c.imagem);
    if (mensagemBoasVindas) link_data.page_welcome_message = mensagemBoasVindas;
    const cr = await graph(`act_${conta}/adcreatives`, { method: 'POST', body: { name: c.nome, object_story_spec: { page_id: pagina, link_data } } });
    const ad = await graph(`act_${conta}/ads`, { method: 'POST', body: { name: c.nome, adset_id: adset.id, creative: { creative_id: cr.id }, status: 'PAUSED' } });
    ads.push({ nome: c.nome, ad_id: ad.id, creative_id: cr.id });
  }
  return { campaign_id: camp.id, adset_id: adset.id, ads };
}

// Ciclo do robô: lê, decide, aplica (simulação por padrão), devolve o relatório.
export async function ciclo({ dryRun = process.env.CAMPANHA_AUTOPAUSAR !== 'on' } = {}) {
  const R = regras();
  const [ins, leads] = await Promise.all([insightsPorAnuncio({ dias: R.janelaDias }), leadsPorAnuncio({ dias: R.janelaDias })]);
  const dec = decidir(ins, leads, R);
  const feitas = await aplicar(dec, { dryRun });
  return { relatorio: relatorio(dec, R) + (feitas.length ? '\n\nAções:\n' + feitas.join('\n') : ''), decisoes: dec, feitas };
}
