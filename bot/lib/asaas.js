// Asaas: cobrança da entrada. O ambiente é decidido pela CHAVE, não pela URL: chave de sandbox ("$aact_hmlg_...")
// sempre fala com o sandbox, mesmo que ASAAS_BASE_URL aponte para produção (evita 401 em toda cobrança quando a URL
// muda antes da chave). Chave de produção usa ASAAS_BASE_URL (padrão https://api.asaas.com/v3).
const SANDBOX = 'https://api-sandbox.asaas.com/v3';
const PRODUCAO = 'https://api.asaas.com/v3';
export function chaveSandbox(key = process.env.ASAAS_API_KEY) { return /\$aact_hmlg_/i.test(String(key || '')); }
export function emProducao() {
  if (!process.env.ASAAS_API_KEY || chaveSandbox()) return false;
  return /api\.asaas\.com/.test(process.env.ASAAS_BASE_URL || PRODUCAO);
}
const BASE = () => {
  if (chaveSandbox()) return SANDBOX;
  return (process.env.ASAAS_BASE_URL || SANDBOX).replace(/\/+$/, '');
};
export function descreverAmbiente() {
  if (!process.env.ASAAS_API_KEY) return 'Asaas: sem chave (cobranças desligadas)';
  const url = /api\.asaas\.com/.test(process.env.ASAAS_BASE_URL || '');
  if (chaveSandbox()) return url ? 'Asaas: chave de SANDBOX com URL de produção; usando o sandbox até a chave de produção chegar' : 'Asaas: sandbox';
  return emProducao() ? 'Asaas: PRODUÇÃO' : 'Asaas: chave de produção com URL de sandbox; ajuste ASAAS_BASE_URL';
}

async function api(path, { method = 'GET', body } = {}) {
  const key = process.env.ASAAS_API_KEY;
  if (!key) throw new Error('[asaas] ASAAS_API_KEY ausente');
  const r = await fetch(`${BASE()}${path}`, {
    method,
    headers: { access_token: key, 'Content-Type': 'application/json', 'User-Agent': 'superendividamento-bot/0.1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`[asaas] ${method} ${path}: ${j?.errors?.[0]?.description || `HTTP ${r.status}`}`);
  return j;
}

export async function garantirCliente({ nome, cpf, celular, email }) {
  const cpfDig = (cpf || '').replace(/\D/g, '');
  if (cpfDig) {
    const q = await api(`/customers?cpfCnpj=${cpfDig}&limit=1`);
    if (q?.data?.[0]?.id) return q.data[0].id;
  }
  const c = await api('/customers', { method: 'POST', body: { name: nome, cpfCnpj: cpfDig || undefined, mobilePhone: celular || undefined, email: email || undefined, notificationDisabled: true } });
  return c.id;
}

// Cobrança única; o pagador escolhe Pix/boleto/cartão na fatura. Vence em 5 dias.
export async function criarCobranca({ customerId, valor, referencia, descricao }) {
  const due = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const p = await api('/payments', { method: 'POST', body: { customer: customerId, billingType: 'UNDEFINED', value: valor, dueDate: due, description: descricao, externalReference: referencia } });
  return { id: p.id, url: p.invoiceUrl, status: p.status };
}

export async function consultarPorReferencia(referencia) {
  const q = await api(`/payments?externalReference=${encodeURIComponent(referencia)}&limit=5`);
  const pagos = (q?.data || []).filter(p => ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(p.status));
  return { pago: pagos.length > 0, pagamento: pagos[0] || q?.data?.[0] || null };
}

export const EVENTOS_PAGO = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
