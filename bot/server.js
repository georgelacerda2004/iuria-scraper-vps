// Robô WhatsApp — Lei do Superendividamento.
// Webhook da WhatsApp Cloud API (Meta) → fluxo de triagem → Supabase do IURIA.
import express from 'express';
import { assinaturaValida, extrairEventos } from './lib/webhook.js';
import { sendText, markRead } from './lib/whatsapp.js';
import { upsertConversa, gravarMensagem, atualizarConversa, carregarHistorico } from './lib/db.js';
import { proximoPasso } from './lib/fluxo.js';
import { verificarConclusao } from './lib/captacao.js';
import { EVENTOS_PAGO } from './lib/asaas.js';
import { db } from './lib/db.js';

const PORT = parseInt(process.env.PORT || '10000', 10);
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || '';

const app = express();
// Corpo bruto é necessário para validar a assinatura HMAC da Meta.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Verificação do webhook (Meta chama 1x ao cadastrar a URL no painel do app).
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Dedup simples em memória (a Meta reenvia se demorarmos a responder 200).
const vistos = new Map();
function jaVisto(id) {
  const agora = Date.now();
  for (const [k, t] of vistos) if (agora - t > 10 * 60_000) vistos.delete(k);
  if (vistos.has(id)) return true;
  vistos.set(id, agora);
  return false;
}

app.post('/webhook', (req, res) => {
  if (!assinaturaValida(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // responde antes de processar: a Meta exige resposta rápida
  const eventos = extrairEventos(req.body);
  for (const ev of eventos) {
    if (ev.kind !== 'message' || jaVisto(ev.messageId)) continue;
    tratarMensagem(ev).catch(err => console.error('[bot] erro ao tratar mensagem:', err.message));
  }
});

// Webhook do Asaas (configurar no painel: URL /webhooks/asaas + token em ASAAS_WEBHOOK_TOKEN).
app.post('/webhooks/asaas', async (req, res) => {
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN || '';
  if (esperado && req.get('asaas-access-token') !== esperado) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    const ev = String(req.body?.event || '');
    const ref = String(req.body?.payment?.externalReference || '');
    if (!EVENTOS_PAGO.has(ev) || !ref.startsWith('SE|')) return;
    const conversaId = ref.slice(3);
    const s = db();
    if (!s) return;
    const { data: conversa } = await s.from('se_conversas').select('*').eq('id', conversaId).maybeSingle();
    if (!conversa) return;
    await s.from('se_conversas').update({ pago_em: conversa.pago_em || new Date().toISOString() }).eq('id', conversaId);
    await checarConversa({ ...conversa, pago_em: conversa.pago_em || new Date().toISOString() });
  } catch (e) { console.error('[asaas-webhook]', e.message); }
});

// Verifica pagamento + assinaturas de uma conversa e, se concluiu, avisa o lead.
async function checarConversa(conversa) {
  const r = await verificarConclusao(conversa);
  if (!r) return;
  for (const texto of r.respostas) {
    const out = await sendText(conversa.wa_id, texto);
    await gravarMensagem({ conversaId: conversa.id, waId: conversa.wa_id, direcao: 'out', tipo: 'text', texto, waMessageId: out?.messages?.[0]?.id });
  }
  if (Object.keys(r.patch).length) await atualizarConversa(conversa.id, r.patch);
}

// A cada 3 min: conversas aguardando pagamento/assinatura (o webhook do Autentique
// atualiza a tabela assinaturas; aqui só lemos o status).
async function verificarPendencias() {
  const s = db();
  if (!s) return;
  const { data } = await s.from('se_conversas').select('*').eq('etapa', 'pagamento_assinatura').limit(50);
  for (const c of data || []) {
    try { await checarConversa(c); } catch (e) { console.error('[pendencias]', c.wa_id, e.message); }
  }
}
if (process.env.NODE_ENV !== 'test') setInterval(() => verificarPendencias().catch(() => {}), 3 * 60_000);

async function tratarMensagem(ev) {
  const conversa = await upsertConversa({ waId: ev.waId, nome: ev.nome, referral: ev.referral });
  await gravarMensagem({ conversaId: conversa.id, waId: ev.waId, direcao: 'in', tipo: ev.tipo, texto: ev.texto, waMessageId: ev.messageId, payload: ev.raw });
  if (ev.referral) console.log(`[bot] lead de anúncio ${ev.referral.source_id} (${ev.referral.headline ?? ''})`);

  markRead(ev.messageId).catch(() => {});
  // Histórico sem a mensagem atual (ela acabou de ser gravada e entra como textoAtual).
  const historico = (await carregarHistorico(conversa.id)).filter(m => !(m.direcao === 'in' && m.texto === ev.texto));
  const { respostas, patch, usage } = await proximoPasso(conversa, ev, { historico });
  if (usage) console.log(`[ia] ${ev.waId} in=${usage.input} out=${usage.output} cache=${usage.cache_read}`);
  for (const texto of respostas) {
    const r = await sendText(ev.waId, texto);
    await gravarMensagem({ conversaId: conversa.id, waId: ev.waId, direcao: 'out', tipo: 'text', texto, waMessageId: r?.messages?.[0]?.id });
  }
  if (Object.keys(patch).length) await atualizarConversa(conversa.id, patch);
}

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`[bot] ouvindo em :${PORT}`));
}
export { app, tratarMensagem };
