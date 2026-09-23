// Validação e leitura do payload do webhook da Cloud API.
import crypto from 'node:crypto';

// X-Hub-Signature-256: sha256=<hmac do corpo bruto com o app secret>
export function assinaturaValida(rawBody, header) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true; // sem secret configurado, não bloqueia (só em dev)
  if (!header || !header.startsWith('sha256=')) return false;
  const esperado = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const recebido = header.slice(7);
  if (esperado.length !== recebido.length) return false;
  return crypto.timingSafeEqual(Buffer.from(esperado, 'hex'), Buffer.from(recebido, 'hex'));
}

// Achata o payload da Meta numa lista de eventos simples.
// Cada mensagem recebida vira { waId, nome, messageId, tipo, texto, mediaId, referral, timestamp }.
export function extrairEventos(body) {
  const eventos = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const nomes = new Map((v.contacts ?? []).map(c => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        const ev = {
          kind: 'message',
          waId: m.from,
          nome: nomes.get(m.from),
          messageId: m.id,
          tipo: m.type,
          timestamp: Number(m.timestamp) * 1000,
          texto: null,
          mediaId: null,
          referral: m.referral ?? null, // presente na 1ª mensagem vinda de anúncio Click-to-WhatsApp
          raw: m,
        };
        if (m.type === 'text') ev.texto = m.text?.body ?? '';
        else if (m.type === 'button') ev.texto = m.button?.text ?? '';
        else if (m.type === 'interactive') ev.texto = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
        else if (['image', 'document', 'audio', 'video'].includes(m.type)) {
          ev.mediaId = m[m.type]?.id ?? null;
          ev.texto = m[m.type]?.caption ?? null;
        }
        eventos.push(ev);
      }
      for (const st of v.statuses ?? []) {
        eventos.push({ kind: 'status', messageId: st.id, status: st.status, waId: st.recipient_id, timestamp: Number(st.timestamp) * 1000 });
      }
    }
  }
  return eventos;
}
