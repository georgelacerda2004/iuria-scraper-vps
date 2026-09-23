// Testes do lib/jev.js com fetch simulado — rodam sem chave e sem rede.
//   npm run test:jev

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ranquearPorRelevancia } from '../lib/jev.js';

const acordaos = [
  { titulo: 'REsp 1', ementa: 'Contrato de locação. Despejo por falta de pagamento.', tribunal: 'STJ' },
  { titulo: 'REsp 2', ementa: 'Dano moral. Inscrição indevida em cadastro de inadimplentes.', tribunal: 'STJ' },
  { titulo: 'REsp 3', ementa: 'Dano moral in re ipsa. Negativação indevida. Quantum.', tribunal: 'STJ' },
];

// Simula o Jev: nota maior pra ementas que contêm "dano moral".
function fakeJev({ status = 200, falhasAntes = 0 } = {}) {
  const chamadas = [];
  let falhas = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    chamadas.push({ url, headers: init.headers, body });
    if (falhas < falhasAntes) {
      falhas++;
      return new Response('overloaded', { status: 529 });
    }
    if (status !== 200) return new Response('{"detail":"bad"}', { status });
    const ementa = body.state.acordao.ementa;
    const score = /dano moral in re ipsa/i.test(ementa) ? 2.9 : /dano moral/i.test(ementa) ? 2.1 : 0.2;
    return Response.json({
      model: 'jev-1.13.0',
      answers: { relevancia: { type: 'score', score, confidence: 0.9 } },
      usage: { input_tokens: 100, output_tokens: 10 },
    });
  };
  return { fetchImpl, chamadas };
}

test('ordena por relevância e preserva posição original', async () => {
  const { fetchImpl, chamadas } = fakeJev();
  const { resultados, ranqueamento } = await ranquearPorRelevancia('dano moral negativação', acordaos, {
    apiKey: 'k', fetchImpl,
  });
  assert.equal(ranqueamento.status, 'ok');
  assert.deepEqual(resultados.map((r) => r.titulo), ['REsp 3', 'REsp 2', 'REsp 1']);
  assert.deepEqual(resultados.map((r) => r.posicaoOriginal), [3, 2, 1]);
  assert.equal(resultados[0].relevancia.score, 2.9);
  assert.equal(ranqueamento.input_tokens, 300);
  assert.ok(ranqueamento.custo_estimado_usd > 0);

  // formato da requisição segue a API oficial
  assert.equal(chamadas.length, 3);
  assert.equal(chamadas[0].headers.Authorization, 'Bearer k');
  const q = chamadas[0].body.questions.relevancia;
  assert.equal(q.type, 'score');
  assert.equal(q.criteria.length, 4);
  assert.equal(chamadas[0].body.state.busca, 'dano moral negativação');
});

test('sem chave: não chama a API e mantém ordem', async () => {
  const { fetchImpl, chamadas } = fakeJev();
  const { resultados, ranqueamento } = await ranquearPorRelevancia('x', acordaos, { apiKey: '', fetchImpl });
  assert.equal(ranqueamento.status, 'desabilitado');
  assert.equal(chamadas.length, 0);
  assert.equal(resultados, acordaos);
});

test('erro da API: fail-open na ordem original', async () => {
  const { fetchImpl } = fakeJev({ status: 401 });
  const { resultados, ranqueamento } = await ranquearPorRelevancia('x', acordaos, { apiKey: 'k', fetchImpl });
  assert.equal(ranqueamento.status, 'erro');
  assert.match(ranqueamento.motivo, /401/);
  assert.equal(resultados, acordaos);
});

test('529 overloaded: tenta de novo e conclui', async () => {
  const { fetchImpl } = fakeJev({ falhasAntes: 1 });
  const { ranqueamento } = await ranquearPorRelevancia('dano moral', acordaos.slice(0, 1), {
    apiKey: 'k', fetchImpl, concorrencia: 1,
  });
  assert.equal(ranqueamento.status, 'ok');
});

test('lista vazia: ok sem chamar a API', async () => {
  const { fetchImpl, chamadas } = fakeJev();
  const { ranqueamento } = await ranquearPorRelevancia('x', [], { apiKey: 'k', fetchImpl });
  assert.equal(ranqueamento.status, 'ok');
  assert.equal(chamadas.length, 0);
});
