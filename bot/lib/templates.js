// Templates de mensagem do WhatsApp (necessários fora da janela de 24 h).
// Descobre a conta WhatsApp Business (WABA) do número, cria os templates que faltam e
// guarda o status (APPROVED/PENDING/REJECTED) em memória, renovando a cada hora.
import { graph } from './whatsapp.js';

const NOME_ROBO = () => process.env.NOME_ROBO || 'Paula';
const ESCRITORIO = () => process.env.NOME_ESCRITORIO || 'AJF Advocacia';

export function definicoes() {
  const assin = `aqui é a ${NOME_ROBO()}, da ${ESCRITORIO()}`;
  return {
    se_retomada: { category: 'UTILITY', text: `Oi {{1}}, ${assin}. Nossa conversa sobre a Lei do Superendividamento ficou no meio. Quer continuar de onde paramos? É só responder esta mensagem.`, example: ['Maria'] },
    se_processo_protocolado: { category: 'UTILITY', text: `Oi {{1}}, ${assin}. Seu processo foi protocolado. Número: {{2}}. Você pode acompanhar em {{3}}. Qualquer dúvida, responda por aqui.`, example: ['Maria', '1000000-00.2026.8.26.0100', 'https://esaj.tjsp.jus.br/cpopg/open.do'] },
    se_andamento: { category: 'UTILITY', text: `Oi {{1}}, ${assin}. Tem novidade no seu processo {{2}}: {{3}}. Se quiser, responda por aqui que eu explico.`, example: ['Maria', '1000000-00.2026.8.26.0100', 'Decisão: liminar analisada pelo juiz'] },
    se_pendencia: { category: 'UTILITY', text: `Oi {{1}}, ${assin}. Ainda falta {{2}} para concluir o seu cadastro. Responda esta mensagem que eu te mando de novo o que precisa.`, example: ['Maria', 'assinar o contrato'] },
  };
}

let wabaId = null;
export async function descobrirWaba() {
  if (wabaId) return wabaId;
  if (process.env.WABA_ID_PROD) return (wabaId = process.env.WABA_ID_PROD);
  const phone = process.env.PHONE_NUMBER_ID;
  const candidatos = new Set();
  try {
    const j = await graph('me/businesses?fields=owned_whatsapp_business_accounts{id},client_whatsapp_business_accounts{id}&limit=50');
    for (const b of j.data || []) for (const k of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) for (const w of b[k]?.data || []) candidatos.add(w.id);
  } catch (e) { console.warn('[templates] me/businesses:', e.message); }
  if (!candidatos.size) {
    try {
      const tk = process.env.WHATSAPP_TOKEN;
      const d = await graph(`debug_token?input_token=${encodeURIComponent(tk)}`);
      for (const g of d.data?.granular_scopes || []) if (/whatsapp_business/.test(g.scope)) for (const id of g.target_ids || []) candidatos.add(id);
    } catch (e) { console.warn('[templates] debug_token:', e.message); }
  }
  for (const id of candidatos) {
    try {
      const p = await graph(`${id}/phone_numbers?fields=id&limit=50`);
      if ((p.data || []).some(n => n.id === phone)) { wabaId = id; break; }
    } catch { /* sem acesso a essa WABA */ }
  }
  if (wabaId) console.log('[templates] WABA do número de produção:', wabaId);
  else console.warn('[templates] não achei a WABA do número; defina WABA_ID_PROD no Render para habilitar templates');
  return wabaId;
}

const status = new Map(); let statusEm = 0;
export async function sincronizar({ criar = true } = {}) {
  const waba = await descobrirWaba();
  if (!waba) return status;
  const defs = definicoes();
  let existentes = [];
  try { existentes = (await graph(`${waba}/message_templates?fields=name,status,language&limit=100`)).data || []; }
  catch (e) { console.warn('[templates] listar:', e.message); return status; }
  for (const [name, d] of Object.entries(defs)) {
    const ex = existentes.find(t => t.name === name && t.language === 'pt_BR');
    if (ex) { status.set(name, ex.status); continue; }
    if (!criar) continue;
    try {
      await graph(`${waba}/message_templates`, { method: 'POST', body: { name, language: 'pt_BR', category: d.category, components: [{ type: 'BODY', text: d.text, example: { body_text: [d.example] } }] } });
      status.set(name, 'PENDING'); console.log('[templates] criado', name, '(aguardando aprovação da Meta)');
    } catch (e) { console.warn('[templates] criar', name, e.message); }
  }
  statusEm = Date.now();
  console.log('[templates] status:', [...status].map(([k, v]) => `${k}=${v}`).join(', ') || 'nenhum');
  return status;
}

export async function disponivel(name) {
  if (Date.now() - statusEm > 3600_000) await sincronizar({ criar: false }).catch(() => {});
  return status.get(name) === 'APPROVED';
}
