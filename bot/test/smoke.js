// Smoke test sem rede: assinatura HMAC, payload da Meta (com referral), cálculo,
// fluxo de consentimento e cérebro com cliente simulado da API.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.META_APP_SECRET = 'segredo-teste';
process.env.ANTHROPIC_API_KEY = 'teste';
const { assinaturaValida, extrairEventos } = await import('../lib/webhook.js');
const { calcularComprometimento } = await import('../lib/calculo.js');
const { montarMensagens, responder } = await import('../lib/cerebro.js');
const { proximoPasso } = await import('../lib/fluxo.js');

// --- webhook ---
const payload = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: '123' },
  contacts: [{ profile: { name: 'Maria Silva' }, wa_id: '5511999990000' }],
  messages: [{ from: '5511999990000', id: 'wamid.1', timestamp: '1758300000', type: 'text', text: { body: 'Oi, vi o anúncio' },
    referral: { source_url: 'https://fb.me/x', source_id: '120200000000', source_type: 'ad', headline: 'Lei do Superendividamento', ctwa_clid: 'abc' } }],
} }] }] };
const raw = Buffer.from(JSON.stringify(payload));
const sig = 'sha256=' + crypto.createHmac('sha256', 'segredo-teste').update(raw).digest('hex');
assert.equal(assinaturaValida(raw, sig), true);
assert.equal(assinaturaValida(raw, 'sha256=' + '0'.repeat(64)), false);
const evs = extrairEventos(payload);
assert.equal(evs[0].nome, 'Maria Silva');
assert.equal(evs[0].referral.source_id, '120200000000');

// --- cálculo ---
const c = calcularComprometimento({ renda_liquida: 3000, despesas_essenciais: 1500, dividas: [
  { credor: 'Banco A', tipo: 'consignado', parcela_mensal: 900, saldo_total: 20000 },
  { credor: 'Cartão B', tipo: 'cartao', parcela_mensal: 400, saldo_total: 6000 },
  { credor: 'Caixa', tipo: 'financiamento_imobiliario', parcela_mensal: 800, saldo_total: 150000 },
] });
assert.equal(c.parcelas_mensais_consideradas, 1300);
assert.equal(c.percentual_renda_comprometido, 43.3);
assert.equal(c.sobra_mensal, -600);
assert.deepEqual(c.credores_excluidos, ['Caixa']);
assert.equal(c.indicativo, 'favoravel');
const d = calcularComprometimento({ renda_liquida: 8000, despesas_essenciais: 2000, dividas: [{ credor: 'X', tipo: 'cartao', parcela_mensal: 500, saldo_total: 500 }] });
assert.equal(d.indicativo, 'desfavoravel');

// --- cérebro: montagem do histórico ---
const msgs = montarMensagens([{ direcao: 'out', texto: 'Olá!' }, { direcao: 'in', texto: 'oi' }, { direcao: 'out', texto: 'conta aí' }], 'ganho 3 mil');
assert.equal(msgs[0].role, 'user');
assert.equal(msgs.at(-1).content, 'ganho 3 mil');

// --- cérebro: loop com API simulada (1 tool_use → texto) ---
let chamadas = 0;
const fakeApi = { beta: { messages: { create: async (req) => {
  chamadas++;
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.ok(req.tools.every(t => t.strict === true));
  if (chamadas === 1) return { stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [
    { type: 'text', text: 'Deixa eu calcular.' },
    { type: 'tool_use', id: 't1', name: 'calcular_comprometimento', input: { renda_liquida: 3000, despesas_essenciais: 0, dividas: [{ credor: 'Banco A', tipo: 'consignado', parcela_mensal: 1200, saldo_total: 0 }] } },
  ] };
  const ultimo = req.messages.at(-1);
  assert.equal(ultimo.role, 'user');
  assert.equal(ultimo.content[0].type, 'tool_result');
  assert.match(ultimo.content[0].content, /"percentual_renda_comprometido":40/);
  return { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Hoje 40% da sua renda vai para dívidas.' }] };
} } } };
const r = await responder({ historico: [], textoAtual: 'ganho 3 mil e pago 1200 de consignado', api: fakeApi });
assert.equal(chamadas, 2);
assert.match(r.texto, /40%/);
assert.equal(r.calculo.percentual_renda_comprometido, 40);

// --- fluxo ---
let f = await proximoPasso({ etapa: 'novo' }, evs[0]);
assert.equal(f.patch.etapa, 'consentimento');
assert.match(f.respostas[0], /Sou um robô/);
f = await proximoPasso({ etapa: 'consentimento' }, { texto: 'sim' });
assert.equal(f.patch.etapa, 'triagem');
f = await proximoPasso({ etapa: 'triagem' }, { texto: 'quero falar com advogado' });
assert.equal(f.patch.etapa, 'handoff');
f = await proximoPasso({ etapa: 'triagem' }, { texto: 'ganho 3 mil' }, { ia: async () => ({ texto: 'ok', triagem: { resultado: 'favoravel', resumo: 'x' }, calculo: { percentual_renda_comprometido: 40 } }) });
assert.equal(f.patch.etapa, 'viavel');
assert.equal(f.patch.triagem.calculo.percentual_renda_comprometido, 40);
f = await proximoPasso({ etapa: 'triagem' }, { texto: 'oi' }, { ia: async () => { throw new Error('boom'); } });
assert.match(f.respostas[0], /problema/);
console.log('smoke ok');
