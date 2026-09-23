// Persistência no Supabase do IURIA (projeto juridicopro), tabelas se_*.
// Sem SUPABASE_SERVICE_ROLE_KEY o robô roda em modo "sem banco" (só loga) — útil no smoke test.
import { createClient } from '@supabase/supabase-js';

let client = null;
export function db() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

// Garante a conversa do contato (1 linha por número) e devolve a linha.
export async function upsertConversa({ waId, nome, referral }) {
  const s = db();
  if (!s) return { id: null, wa_id: waId, etapa: 'novo' };
  const patch = { wa_id: waId, nome_perfil: nome ?? null, ultima_msg_em: new Date().toISOString() };
  if (referral) {
    patch.origem = 'ads_whatsapp';
    patch.ad_id = referral.source_id ?? null;
    patch.ctwa_clid = referral.ctwa_clid ?? null;
    patch.referral = referral;
  }
  const { data, error } = await s
    .from('se_conversas')
    .upsert(patch, { onConflict: 'wa_id' })
    .select()
    .single();
  if (error) throw new Error(`[db] upsertConversa: ${error.message}`);
  return data;
}

export async function gravarMensagem({ conversaId, waId, direcao, tipo, texto, waMessageId, payload }) {
  const s = db();
  if (!s) { console.log(`[db:off] ${direcao} ${waId} ${tipo}: ${texto ?? ''}`); return; }
  const { error } = await s.from('se_mensagens').insert({
    conversa_id: conversaId, wa_id: waId, direcao, tipo, texto: texto ?? null,
    wa_message_id: waMessageId ?? null, payload: payload ?? null,
  });
  if (error && !/duplicate key/.test(error.message)) throw new Error(`[db] gravarMensagem: ${error.message}`);
}

export async function atualizarConversa(conversaId, patch) {
  const s = db();
  if (!s || !conversaId) return;
  const { error } = await s.from('se_conversas').update(patch).eq('id', conversaId);
  if (error) throw new Error(`[db] atualizarConversa: ${error.message}`);
}
