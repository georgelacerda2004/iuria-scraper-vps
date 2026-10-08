// Robô WhatsApp — Lei do Superendividamento.
// Webhook da WhatsApp Cloud API (Meta) → fluxo de triagem → Supabase do IURIA.
import express from 'express';
import { assinaturaValida, extrairEventos } from './lib/webhook.js';
import { sendText, markRead } from './lib/whatsapp.js';
import { upsertConversa, gravarMensagem, atualizarConversa, carregarHistorico } from './lib/db.js';
import { proximoPasso } from './lib/fluxo.js';
import { verificarConclusao, concluirCadastro, cpfValido, MSG as CAP } from './lib/captacao.js';
import { EVENTOS_PAGO } from './lib/asaas.js';
import { db } from './lib/db.js';
import { ciclo as cicloCampanha } from './lib/campanha.js';
import { avisarOperador } from './lib/iuria.js';
import { montarBriefing } from './lib/briefing.js';

// Variáveis ainda não preenchidas no Render vêm como "PREENCHER": tratar como ausentes.
for (const [k, v] of Object.entries(process.env)) if (v === 'PREENCHER') delete process.env[k];
const faltando = ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'META_APP_SECRET', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'ASAAS_API_KEY'].filter(k => !process.env[k]);
if (faltando.length) console.warn('[bot] variáveis ainda não preenchidas:', faltando.join(', '));
// Diagnóstico: só os NOMES das variáveis opcionais ausentes (nunca valores), para conferir o painel do Render pelo log.
const OPCIONAIS = ['WABA_ID', 'WEBHOOK_VERIFY_TOKEN', 'SUPABASE_URL', 'CLAUDE_MODEL', 'NOME_ROBO', 'NOME_ESCRITORIO', 'ESCRITORIO_ID',
  'ADVOGADO_NOME', 'ADVOGADO_OAB', 'RESPONSAVEL_NOME', 'ESCRITORIO_ENDERECO', 'FORO_CONTRATO', 'TRIBUNAL_PADRAO', 'HONORARIOS_ENTRADA',
  'ASAAS_BASE_URL', 'ASAAS_WEBHOOK_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'META_ADS_TOKEN', 'META_AD_ACCOUNT_ID', 'META_PAGE_ID',
  'SISTEMA_PADRAO', 'CAMPANHA_AUTOPAUSAR', 'OPERADOR_WHATSAPP', 'NODE_VERSION'];
const ausentes = OPCIONAIS.filter(k => !process.env[k]);
console.log('[bot] variáveis opcionais ausentes (padrão interno ou recurso desligado):', ausentes.length ? ausentes.join(', ') : 'nenhuma');

const PORT = parseInt(process.env.PORT || '10000', 10);
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || '';

const app = express();
// Corpo bruto é necessário para validar a assinatura HMAC da Meta.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Verificação do webhook (Meta chama 1x ao cadastrar a URL no painel do app).
app.get('/webhook', (req, res) => {
  console.log(`[webhook] verificação recebida da Meta (mode=${req.query['hub.mode']})`);
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
  if (!assinaturaValida(req.rawBody, req.get('x-hub-signature-256'))) { console.warn('[webhook] assinatura inválida'); return res.sendStatus(401); }
  res.sendStatus(200); // responde antes de processar: a Meta exige resposta rápida
  const eventos = extrairEventos(req.body);
  console.log(`[webhook] ${eventos.filter(e => e.kind === 'message').length} mensagem(ns), ${eventos.filter(e => e.kind === 'status').length} status`);
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
  await recuperarCadastros();
  await retomarConversas();
}

// Conversas marcadas para retomada pelo operador (etapa = 'retomar', ex.: handoff que não precisava):
// o robô se reapresenta, pede o primeiro documento e volta ao fluxo normal.
async function retomarConversas() {
  const s = db();
  if (!s) return;
  const { data } = await s.from('se_conversas').select('*').eq('etapa', 'retomar').limit(20);
  for (const c of data || []) {
    try {
      const texto = CAP.retomada(c.nome_perfil);
      const out = await sendText(c.wa_id, texto);
      await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: 'text', texto, waMessageId: out?.messages?.[0]?.id });
      await atualizarConversa(c.id, { etapa: 'docs', handoff_em: null, handoff_motivo: null });
      console.log('[retomar]', c.wa_id, 'voltou para docs');
    } catch (e) { console.error('[retomar]', c.wa_id, e.message); }
  }
}

// Conversas que caíram em handoff por erro no cadastro (bug ou instabilidade) com os 3 documentos já
// recebidos: tenta concluir o cadastro de novo. Se der certo, manda os links e segue o fluxo normal.
const SLOTS_DOCS = ['pessoal', 'endereco', 'renda'];
async function recuperarCadastros() {
  const s = db();
  const { data } = await s.from('se_conversas').select('*').eq('etapa', 'handoff').like('handoff_motivo', 'erro_cadastro:%').limit(20);
  for (const c of data || []) {
    const docs = c.triagem?.documentos || {};
    if (!SLOTS_DOCS.every(k => docs[k]?.path)) continue;
    const tentativas = Number(c.triagem?.recuperacao_tentativas || 0);
    if (tentativas >= 3) continue;
    if (!cpfValido(c.triagem?.dados?.cpf)) {
      // Sem CPF não há cobrança nem cadastro: devolve a conversa para 'docs' e pede o número por texto.
      const out = await sendText(c.wa_id, CAP.pedirCpf);
      await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: 'text', texto: CAP.pedirCpf, waMessageId: out?.messages?.[0]?.id });
      await atualizarConversa(c.id, { etapa: 'docs', handoff_em: null, handoff_motivo: null });
      console.log('[recuperacao] CPF ausente, pedido por texto:', c.wa_id);
      continue;
    }
    try {
      const r = await concluirCadastro(c);
      for (const texto of r.respostas) {
        const out = await sendText(c.wa_id, texto);
        await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: 'text', texto, waMessageId: out?.messages?.[0]?.id });
      }
      await atualizarConversa(c.id, { ...r.patch, handoff_em: null, handoff_motivo: null });
      console.log('[recuperacao] cadastro concluído após falha anterior:', c.wa_id);
    } catch (e) {
      console.error('[recuperacao] ainda falhou:', c.wa_id, e.message);
      await atualizarConversa(c.id, { triagem: { ...(c.triagem || {}), recuperacao_tentativas: tentativas + 1 }, handoff_motivo: 'erro_cadastro:' + e.message });
    }
  }
}
if (process.env.NODE_ENV !== 'test') setInterval(() => verificarPendencias().catch(() => {}), 3 * 60_000);

// Robô de campanha: a cada 4 h lê o Meta, cruza com o CRM e (se CAMPANHA_AUTOPAUSAR=on) pausa o que estourou o teto.
// Relatório vai ao Telegram 1x por dia, às 8h de Brasília.
let ultimoRelatorioDia = '';
async function rodarCampanha() {
  if (!process.env.META_ADS_TOKEN || !process.env.META_PAGE_ID) return;
  const r = await cicloCampanha();
  console.log(`[campanha] ciclo ok: ${r.decisoes.length} anúncio(s) avaliado(s), ${r.feitas.length} ação(ões)`);
  const hojeSP = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const horaSP = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
  if (r.feitas.length || (horaSP >= 8 && ultimoRelatorioDia !== hojeSP)) { await avisarOperador(r.relatorio); ultimoRelatorioDia = hojeSP; }
  else console.log('[campanha]\n' + r.relatorio);
}
if (process.env.NODE_ENV !== 'test') { setTimeout(() => rodarCampanha().catch(e => console.error('[campanha]', e.message)), 60_000); setInterval(() => rodarCampanha().catch(e => console.error('[campanha]', e.message)), 4 * 3600_000); }

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
  if (patch.etapa === 'handoff') await avisarHandoff({ ...conversa, ...patch });
}

// Aviso ao advogado com número e briefing quando a conversa passa para humano (Telegram e,
// se OPERADOR_WHATSAPP estiver definido, também pelo WhatsApp do robô).
async function avisarHandoff(conversa) {
  try {
    const mensagens = await carregarHistorico(conversa.id);
    const texto = montarBriefing({ conversa, mensagens, motivo: conversa.handoff_motivo });
    await avisarOperador(texto);
    const op = process.env.OPERADOR_WHATSAPP;
    if (op) await sendText(op, texto).catch(e => console.warn('[handoff] aviso por WhatsApp falhou:', e.message));
  } catch (e) { console.error('[handoff] aviso falhou:', e.message); }
}

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`[bot] ouvindo em :${PORT}`));
}
export { app, tratarMensagem };
