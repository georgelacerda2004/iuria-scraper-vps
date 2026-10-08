// Cliente mínimo da WhatsApp Cloud API (Graph API v21).
// Só o que o robô precisa: mandar texto, marcar como lida, baixar mídia.
const GRAPH = 'https://graph.facebook.com/v21.0';

function cfg() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('WHATSAPP_TOKEN e PHONE_NUMBER_ID são obrigatórios');
  return { token, phoneId };
}

export async function graph(path, { method = 'GET', body } = {}) {
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

// Mensagem de template (única forma permitida fora da janela de 24 h desde a última mensagem da pessoa).
export async function sendTemplate(to, name, params = [], { lang = 'pt_BR' } = {}) {
  const { phoneId } = cfg();
  return graph(`${phoneId}/messages`, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: { name, language: { code: lang }, components: params.length ? [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).replace(/[\n\t]+/g, ' ').slice(0, 1000) })) }] : [] },
    },
  });
}

// Janela de 24 h: fora dela a Meta recusa texto livre (erro 131047) e só aceita template.
export function dentroDaJanela(ultimaEntradaEm, agora = Date.now()) {
  if (!ultimaEntradaEm) return false;
  return agora - new Date(ultimaEntradaEm).getTime() < 24 * 3600_000 - 5 * 60_000;
}

// Manda texto se a janela estiver aberta; senão, o template (se houver). Devolve { out, via } ou null se não pôde.
export async function enviar({ to, texto, ultimaEntradaEm, template, params = [], templateDisponivel = async () => false }) {
  if (dentroDaJanela(ultimaEntradaEm)) {
    try { return { out: await sendText(to, texto), via: 'texto', texto }; }
    catch (e) { if (!/131047|re-engagement|24 hours/i.test(e.message)) throw e; }
  }
  if (template && await templateDisponivel(template)) return { out: await sendTemplate(to, template, params), via: 'template', texto: `[template ${template}] ${params.join(' | ')}` };
  return null;
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
