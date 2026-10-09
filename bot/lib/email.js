// E-mail transacional (Resend, API REST). Sem RESEND_API_KEY só loga: o resto do robô não depende disso.
export async function enviarEmail({ para, assunto, html, texto }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'Paula <paula@ajfadvocacia.adv.br>';
  if (!key) { console.log(`[email:off] para ${para}: ${assunto}`); return { ok: false, motivo: 'RESEND_API_KEY ausente' }; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: Array.isArray(para) ? para : [para], subject: assunto, html, text: texto }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.warn('[email]', para, j?.message || r.status); return { ok: false, motivo: j?.message || String(r.status) }; }
  return { ok: true, id: j.id };
}
export const esc = (t) => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
