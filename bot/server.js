// Robô WhatsApp — Lei do Superendividamento.
// Webhook da WhatsApp Cloud API (Meta) → fluxo de triagem → Supabase do IURIA.
import express from 'express';
import { assinaturaValida, extrairEventos } from './lib/webhook.js';
import { sendText, markRead } from './lib/whatsapp.js';
import { upsertConversa, gravarMensagem, atualizarConversa } from './lib/db.js';
import { proximoPasso } from './lib/fluxo.js';

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

async function tratarMensagem(ev) {
  const conversa = await upsertConversa({ waId: ev.waId, nome: ev.nome, referral: ev.referral });
  await gravarMensagem({ conversaId: conversa.id, waId: ev.waId, direcao: 'in', tipo: ev.tipo, texto: ev.texto, waMessageId: ev.messageId, payload: ev.raw });
  if (ev.referral) console.log(`[bot] lead de anúncio ${ev.referral.source_id} (${ev.referral.headline ?? ''})`);

  markRead(ev.messageId).catch(() => {});
  const { respostas, patch } = proximoPasso(conversa, ev);
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
