// Cliente mínimo da WhatsApp Cloud API (Graph API v21).
// Só o que o robô precisa: mandar texto, marcar como lida, baixar mídia.
const GRAPH = 'https://graph.facebook.com/v21.0';

function cfg() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('WHATSAPP_TOKEN e PHONE_NUMBER_ID são obrigatórios');
  return { token, phoneId };
}

async function graph(path, { method = 'GET', body } = {}) {
  const { token } = cfg();
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`[whatsapp] ${method} ${path}: ${msg}`);
  }
  return json;
}

export async function sendText(to, text, { previewUrl = false } = {}) {
  const { phoneId } = cfg();
  return graph(`${phoneId}/messages`, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: previewUrl },
    },
  });
}

export async function markRead(messageId) {
  const { phoneId } = cfg();
  return graph(`${phoneId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
  });
}

// Mídia (foto do RG, PDF do extrato): primeiro pega a URL temporária, depois baixa com o token.
export async function downloadMedia(mediaId) {
  const { token } = cfg();
  const meta = await graph(mediaId);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`[whatsapp] download ${mediaId}: HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type, sha256: meta.sha256 };
}
