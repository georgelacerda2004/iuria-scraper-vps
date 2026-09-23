// Smoke test sem rede: verifica a assinatura HMAC, a extração do payload da Meta
// (inclusive o referral do anúncio) e o fluxo de consentimento.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.META_APP_SECRET = 'segredo-teste';
const { assinaturaValida, extrairEventos } = await import('../lib/webhook.js');
const { proximoPasso } = await import('../lib/fluxo.js');

const payload = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: '123' },
  contacts: [{ profile: { name: 'Maria Silva' }, wa_id: '5511999990000' }],
  messages: [{ from: '5511999990000', id: 'wamid.1', timestamp: '1758300000', type: 'text', text: { body: 'Oi, vi o anúncio' },
    referral: { source_url: 'https://fb.me/x', source_id: '120200000000', source_type: 'ad', headline: 'Lei do Superendividamento', ctwa_clid: 'abc' } }],
} }] }] };
const raw = Buffer.from(JSON.stringify(payload));
const sig = 'sha256=' + crypto.createHmac('sha256', 'segredo-teste').update(raw).digest('hex');
assert.equal(assinaturaValida(raw, sig), true, 'assinatura correta deve passar');
assert.equal(assinaturaValida(raw, 'sha256=' + '0'.repeat(64)), false, 'assinatura errada deve falhar');

const evs = extrairEventos(payload);
assert.equal(evs.length, 1);
assert.equal(evs[0].nome, 'Maria Silva');
assert.equal(evs[0].texto, 'Oi, vi o anúncio');
assert.equal(evs[0].referral.source_id, '120200000000');

let r = proximoPasso({ etapa: 'novo' }, evs[0]);
assert.equal(r.patch.etapa, 'consentimento');
assert.match(r.respostas[0], /Sou um robô/);
r = proximoPasso({ etapa: 'consentimento' }, { texto: 'sim' });
assert.equal(r.patch.etapa, 'triagem');
r = proximoPasso({ etapa: 'triagem' }, { texto: 'quero falar com advogado' });
assert.equal(r.patch.etapa, 'handoff');
console.log('smoke ok');
