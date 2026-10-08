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
assert.equal(assinaturaValida(raw, undefined), false, 'sem header deve falhar');
{ const bak = process.env.META_APP_SECRET; delete process.env.META_APP_SECRET;
  assert.equal(assinaturaValida(raw, sig), false, 'sem secret deve recusar (fail-closed)');
  process.env.WEBHOOK_INSECURE = '1'; assert.equal(assinaturaValida(raw, sig), true); delete process.env.WEBHOOK_INSECURE;
  process.env.META_APP_SECRET = bak; }
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
  assert.equal(req.system.length, 1); // triagem: só o bloco cacheado
  assert.ok(req.tools.some(t => t.name === 'aceitar_proposta'));
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
// fase proposta: segundo bloco de system com o roteiro; aceitar_proposta devolve proposta
const fakeProp = { beta: { messages: { create: async (req) => {
  assert.equal(req.system.length, 2); assert.match(req.system[1].text, /FASE ATUAL: PROPOSTA/); assert.match(req.system[1].text, /R\$ 500,00/);
  if (req.messages.length === 1) return { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'p1', name: 'aceitar_proposta', input: { pagamento: 'agora' } }] };
  return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Combinado!' }] };
} } } };
const rp = await responder({ historico: [], textoAtual: 'quero seguir', fase: 'proposta', api: fakeProp });
assert.deepEqual(rp.proposta, { aceita: true, pagamento: 'agora' }); assert.equal(rp.texto, 'Combinado!');
assert.equal(chamadas, 2);
assert.match(r.texto, /40%/);
assert.equal(r.calculo.percentual_renda_comprometido, 40);

// --- fluxo ---
let f = await proximoPasso({ etapa: 'novo' }, evs[0]);
assert.equal(f.patch.etapa, 'consentimento');
assert.match(f.respostas[0], /atendimento inicial é automático/);
f = await proximoPasso({ etapa: 'consentimento' }, { texto: 'sim' });
assert.equal(f.patch.etapa, 'triagem');
f = await proximoPasso({ etapa: 'triagem' }, { texto: 'quero falar com advogado' });
assert.equal(f.patch.etapa, 'handoff');
f = await proximoPasso({ etapa: 'triagem' }, { texto: 'ganho 3 mil' }, { ia: async () => ({ texto: 'ok', triagem: { resultado: 'favoravel', resumo: 'x' }, calculo: { percentual_renda_comprometido: 40 } }) });
assert.equal(f.patch.etapa, 'proposta'); // favorável: Paula explica o processo e as condições antes dos documentos
assert.equal(f.respostas.length, 1);
assert.equal(f.patch.triagem.calculo.percentual_renda_comprometido, 40);
// proposta aceita → pede o RG no mesmo turno e guarda a forma da entrada
let faseVista = null;
f = await proximoPasso({ etapa: 'proposta', triagem: { resultado: 'favoravel' } }, { texto: 'quero sim' }, { ia: async ({ fase }) => { faseVista = fase; return { texto: 'Ótimo!', proposta: { aceita: true, pagamento: 'apos_liminar' } }; } });
assert.equal(faseVista, 'proposta');
assert.equal(f.patch.etapa, 'docs'); assert.equal(f.respostas.length, 2); assert.match(f.respostas[1], /RG ou CNH/);
assert.equal(f.patch.triagem.pagamento, 'apos_liminar'); assert.equal(f.patch.triagem.resultado, 'favoravel');
f = await proximoPasso({ etapa: 'proposta', triagem: {} }, { texto: 'não quero' }, { ia: async () => ({ texto: 'Tudo bem.', proposta: { aceita: false, motivo: 'sem interesse' } }) });
assert.equal(f.patch.etapa, 'desistiu');
f = await proximoPasso({ etapa: 'triagem' }, { texto: 'x' }, { ia: async () => ({ texto: 'ok', triagem: { resultado: 'favoravel', resumo: 'x' }, handoff: 'pediu advogado' }) });
assert.equal(f.patch.etapa, 'handoff'); // pedido explícito vence
assert.equal(f.respostas.length, 1);
const CAPm = (await import('../lib/captacao.js')).MSG;
assert.match(CAPm.retomada('Jane Silva'), /^Jane, aqui é a Paula de novo/);
f = await proximoPasso({ etapa: 'triagem' }, { texto: 'oi' }, { ia: async () => { throw new Error('boom'); } });
assert.match(f.respostas[0], /problema/);
console.log('smoke ok');

// --- documentos: os 3 PDFs saem válidos ---
process.env.ADVOGADO_NOME = 'Advogado Teste'; process.env.ADVOGADO_OAB = 'OAB/SP nº 123.456'; process.env.ESCRITORIO_ID = 'esc-1';
const { gerarTodos } = await import('../lib/documentos.js');
const clienteFake = { id: 'cli-1', nome: 'Maria Silva Souza', cpf: '123.456.789-09', rg: '12.345.678-9', endereco: 'Rua A, 10', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP', cep: '01000-000', criado_por: 'u1' };
const triagemFake = { resumo: 'ok', fonte_renda: 'clt', calculo: { renda_liquida: 3000, parcelas_mensais_consideradas: 1300, percentual_renda_comprometido: 43.3, sobra_mensal: -600, minimo_existencial: 600 }, dividas: [{ credor: 'Banco A', tipo: 'consignado', parcela_mensal: 900, saldo_total: 20000 }] };
const pdfs = await gerarTodos(clienteFake, triagemFake);
assert.equal(pdfs.length, 3);
const pdfsDif = await gerarTodos(clienteFake, { ...triagemFake, pagamento: 'apos_liminar' });
assert.ok(pdfsDif[1].pdf.length > 1500 && pdfsDif[1].pdf.length !== pdfs[1].pdf.length, 'contrato diferido deveria mudar');
for (const d of pdfs) { assert.ok(d.pdf.length > 1500, d.tipo + ' pequeno demais'); assert.equal(d.pdf.subarray(0, 4).toString(), '%PDF'); }

// --- captacao: documentos pelo chat ---
const { receberDocumento, concluirCadastro, verificarConclusao } = await import('../lib/captacao.js');
const capDeps = {
  baixar: async () => ({ buffer: Buffer.from('img'), mime: 'image/jpeg' }),
  guardar: async ({ slot }) => `se-uploads/c1/${slot}.jpg`,
  classificar: async (path) => path.includes('pessoal') ? { tipo: 'RG', dados: { nome: 'Maria Silva Souza', cpf: '12345678909' } } : path.includes('endereco') ? { tipo: 'Comprovante de residência', dados: { endereco: 'Rua A, 10', cidade: 'São Paulo', uf: 'SP' } } : { tipo: 'Holerite', dados: {} },
};
let conv = { id: 'c1', wa_id: '5511999990000', nome_perfil: 'Maria', etapa: 'docs', triagem: triagemFake };
let d1 = await receberDocumento(conv, { texto: 'oi' }, capDeps);
assert.match(d1.respostas[0], /Preciso do arquivo/);
d1 = await receberDocumento(conv, { mediaId: 'm1', tipo: 'image' }, capDeps);
assert.ok(d1.patch.triagem.documentos.pessoal.path);
assert.equal(d1.patch.triagem.dados.cpf, '12345678909');
assert.match(d1.respostas[0], /comprovante de endereço/);
conv = { ...conv, ...d1.patch };
const d2 = await receberDocumento(conv, { mediaId: 'm2', tipo: 'image' }, capDeps); conv = { ...conv, ...d2.patch };
const d3 = await receberDocumento(conv, { mediaId: 'm3', tipo: 'document' }, capDeps); conv = { ...conv, ...d3.patch };
assert.equal(d3.acao, 'concluir');
assert.equal(conv.triagem.dados.endereco, 'Rua A, 10');

// --- captacao: cadastro + cobrança + assinatura (tudo simulado) ---
const enviados = [];
const cc = await concluirCadastro(conv, {
  criarCliente: async ({ dados }) => ({ ...clienteFake, nome: dados.nome }),
  registrarDoc: async () => {},
  asaasCliente: async () => 'cus_1',
  asaasCobranca: async ({ referencia, valor }) => { assert.equal(referencia, 'SE|c1'); assert.equal(valor, 500); return { id: 'pay_1', url: 'https://asaas/pay_1' }; },
  enviar: async ({ tipoDoc }) => { enviados.push(tipoDoc); return { autentiqueId: 'autq_' + tipoDoc, link: 'https://autentique/' + tipoDoc }; },
});
assert.equal(cc.patch.etapa, 'pagamento_assinatura');
assert.deepEqual(enviados, ['se_procuracao', 'se_contrato', 'se_declaracao']);
assert.match(cc.respostas[0], /https:\/\/asaas\/pay_1/);
assert.match(cc.respostas[0], /3\. Declaração/);
let cobrou = false;
const ccDif = await concluirCadastro({ ...conv, triagem: { ...conv.triagem, pagamento: 'apos_liminar' } }, {
  criarCliente: async () => clienteFake, registrarDoc: async () => {}, asaasCliente: async () => { cobrou = true; return 'x'; }, asaasCobranca: async () => { cobrou = true; return {}; },
  enviar: async ({ tipoDoc }) => ({ autentiqueId: 'a_' + tipoDoc, link: 'https://autentique/' + tipoDoc }),
});
assert.equal(cobrou, false); assert.equal(ccDif.patch.asaas_payment_id, null); assert.match(ccDif.respostas[0], /depois da liminar/); assert.doesNotMatch(ccDif.respostas[0], /asaas/);
conv = { ...conv, ...cc.patch };

// --- captacao: ainda pendente → só marca pago; depois concluído → processo ---
let avisos = [];
const vDeps = {
  consultarPagamento: async () => ({ pago: true }),
  statusAss: async (ids) => ids.map((id, i) => ({ autentique_id: id, status: i < 2 ? 'assinado' : 'pendente' })),
  buscarCliente: async () => clienteFake,
  criarProcesso: async () => 'proc-1', criarEntrevista: async () => 'ent-1', honorario: async () => {}, avisar: async (t) => avisos.push(t),
  preparar: async () => ({ distribuicaoId: 'dist-1', viabilidade: { fundamento_resumo: 'ok' } }),
};
let v = await verificarConclusao(conv, vDeps);
assert.ok(v.patch.pago_em); assert.equal(v.respostas.length, 0); assert.equal(v.patch.etapa, undefined);
conv = { ...conv, ...v.patch };
v = await verificarConclusao(conv, { ...vDeps, statusAss: async (ids) => ids.map(id => ({ autentique_id: id, status: 'assinado' })) });
assert.equal(v.patch.etapa, 'cliente'); assert.equal(v.patch.processo_id, 'proc-1'); assert.ok(avisos.length >= 1);
await new Promise(r => setTimeout(r, 20)); assert.equal(avisos.length, 2); assert.match(avisos[1], /PETIÇÃO PRONTA/);
assert.match(v.respostas[0], /tudo confirmado/i);
let hon = null;
const vDif = await verificarConclusao({ ...conv, pago_em: null, triagem: { ...conv.triagem, pagamento: 'apos_liminar' } }, { ...vDeps, consultarPagamento: async () => { throw new Error('não deveria consultar'); }, statusAss: async (ids) => ids.map(id => ({ autentique_id: id, status: 'assinado' })), honorario: async (h) => { hon = h; }, avisar: async () => {}, preparar: async () => ({}) });
assert.equal(vDif.patch.etapa, 'cliente'); assert.equal(hon.diferido, true); assert.match(vDif.respostas[0], /documentos assinados/);

// --- fluxo: viavel → docs ---
f = await proximoPasso({ etapa: 'viavel', nome_perfil: 'Maria Silva' }, { texto: 'ok' });
assert.equal(f.patch.etapa, 'docs'); assert.match(f.respostas[0], /RG ou CNH/);

// --- servidor: webhook do Asaas exige o token ---
process.env.ASAAS_WEBHOOK_TOKEN = 'tok';
const { app } = await import('../server.js');
const srv = app.listen(0); const port = srv.address().port;
let rr = await fetch(`http://127.0.0.1:${port}/webhooks/asaas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(rr.status, 401);
rr = await fetch(`http://127.0.0.1:${port}/webhooks/asaas`, { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': 'tok' }, body: JSON.stringify({ event: 'PAYMENT_CONFIRMED', payment: { externalReference: 'SE|c1' } }) });
assert.equal(rr.status, 200);
srv.close();
console.log('smoke ok (captacao)');

// --- petição: entrevista, distribuição e orquestração com simulações ---
const { montarEntrevista, montarDistribuicao, prepararProtocolo } = await import('../lib/peticao.js');
const ent = montarEntrevista({ cliente: clienteFake, triagem: { ...triagemFake, calculo: { ...triagemFake.calculo, saldo_total_considerado: 26000, credores_excluidos: [] } } });
assert.match(ent, /art\. 104-A/); assert.match(ent, /Banco A/); assert.match(ent, /R\$ 3\.000,00/); assert.ok(ent.length > 50);
const dist = montarDistribuicao({ cliente: clienteFake, processoId: 'p1', entrevistaId: 'e1', triagem: { ...triagemFake, calculo: { ...triagemFake.calculo, saldo_total_considerado: 26000 } }, escritorioId: 'esc-1', criadoPor: 'u1', anexos: [] });
assert.equal(dist.status, 'rascunho'); assert.equal(dist.partes.ativo[0].logradouro, 'Rua A'); assert.equal(dist.partes.ativo[0].numero, '10');
assert.equal(dist.partes.passivo[0].nome, 'Banco A'); assert.equal(dist.valor_causa, 26000); assert.equal(dist.tribunal, 'TJSP');
let inserido = null, payloadGerar = null;
const pp = await prepararProtocolo({ conversa: { triagem: { ...triagemFake, documentos: { pessoal: { path: 'se-uploads/c1/pessoal.jpg', mime: 'image/jpeg' } } } }, cliente: clienteFake, processoId: 'p1', entrevistaId: 'e1', escritorioId: 'esc-1', historicoTexto: '', deps: { gerar: async (x) => { payloadGerar = x; return { html: '<html>', viabilidade: { tem_direito: true }, preco: 1.2 }; }, inserir: async (l) => { inserido = l; return 'dist-9'; } } });
assert.equal(pp.distribuicaoId, 'dist-9'); assert.equal(inserido.anexos.length, 1); assert.equal(payloadGerar.anexos[0].storage_path, 'se-uploads/c1/pessoal.jpg');

// --- campanha: regras de decisão e relatório ---
const { decidir, relatorio: relCamp } = await import('../lib/campanha.js');
const R = { orcamentoDiario: 100, gastoMinimoParaJulgar: 60, tetoCustoConversa: 25, tetoCustoLeadQualificado: 120, janelaDias: 7 };
const ins = [
  { ad_id: 'a1', ad_name: 'A1', gasto: 80, conversas: 0, impressoes: 1000, cliques: 20 },
  { ad_id: 'a2', ad_name: 'A2', gasto: 90, conversas: 2, impressoes: 1000, cliques: 20 },
  { ad_id: 'a3', ad_name: 'A3', gasto: 100, conversas: 8, impressoes: 1000, cliques: 20 },
  { ad_id: 'a4', ad_name: 'A4', gasto: 30, conversas: 0, impressoes: 100, cliques: 2 },
  { ad_id: 'a5', ad_name: 'A5', gasto: 300, conversas: 20, impressoes: 1000, cliques: 20 },
];
const dec = decidir(ins, { a3: { leads: 8, qualificados: 2, pagos: 1 }, a5: { leads: 20, qualificados: 2, pagos: 0 } }, R);
const byId = Object.fromEntries(dec.map(d => [d.ad_id, d]));
assert.equal(byId.a1.acao, 'pausar');      // gastou sem conversa
assert.equal(byId.a2.acao, 'pausar');      // R$45/conversa e zero qualificado
assert.equal(byId.a3.acao, 'destacar');    // tem cliente pago
assert.equal(byId.a4.acao, 'manter');      // ainda não gastou o mínimo
assert.equal(byId.a5.acao, 'pausar');      // R$150 por qualificado > 120
const rel = relCamp(dec, R);
assert.match(rel, /Gasto R\$ 600\.00/); assert.match(rel, /A5: R\$ 300 .* PAUSAR/);
console.log('smoke ok (peticao + campanha)');

// Cada criativo padrão precisa ter o cartão de imagem gerado (bot/anuncios/gerar.py).
{
  const { CRIATIVOS_PADRAO } = await import('../lib/campanha.js');
  const { existsSync } = await import('node:fs');
  for (const c of CRIATIVOS_PADRAO) {
    if (!c.imagem || !existsSync(new URL('../' + c.imagem, import.meta.url))) throw new Error('imagem do anúncio ausente: ' + c.imagem);
  }
  console.log('smoke ok (imagens dos anúncios)');
}

// Regressão: o insert em clientes só aceita aviso_whatsapp em off|manual|auto (constraint do IURIA).
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/iuria.js', import.meta.url), 'utf-8');
  const m = src.match(/aviso_whatsapp:\s*'([a-z]+)'/);
  if (!m || !['off', 'manual', 'auto'].includes(m[1])) throw new Error('aviso_whatsapp fora de off|manual|auto');
  console.log('smoke ok (aviso_whatsapp)');
}

// CPF por texto quando o OCR não leu.
{
  const { cpfValido, receberDocumento, MSG: CAPM } = await import('../lib/captacao.js');
  if (!cpfValido('529.982.247-25') || cpfValido('111.111.111-11') || cpfValido('123')) throw new Error('cpfValido errado');
  const docs = { pessoal: { path: 'a' }, endereco: { path: 'b' }, renda: { path: 'c' } };
  let r = await receberDocumento({ id: 'x', triagem: { dados: { nome: 'Teste' }, documentos: docs } }, { texto: 'oi' });
  if (r.acao || r.respostas[0] !== CAPM.pedirCpf) throw new Error('deveria pedir CPF');
  r = await receberDocumento({ id: 'x', triagem: { dados: { nome: 'Teste' }, documentos: docs } }, { texto: 'meu cpf é 529.982.247-25' });
  if (r.acao !== 'concluir' || r.patch.triagem.dados.cpf !== '52998224725') throw new Error('deveria concluir com o CPF informado');
  r = await receberDocumento({ id: 'x', triagem: { dados: { cpf: '52998224725' }, documentos: docs } }, { texto: 'qualquer' });
  if (r.acao !== 'concluir') throw new Error('com CPF válido deveria concluir direto');
  console.log('smoke ok (cpf por texto)');
}

// Briefing de handoff: número formatado, link, triagem e últimas mensagens.
{
  const { montarBriefing, formatarTelefone } = await import('../lib/briefing.js');
  if (formatarTelefone('5514996426132') !== '+55 14 99642-6132' || formatarTelefone('551133334444') !== '+55 11 3333-4444') throw new Error('telefone mal formatado');
  const b = montarBriefing({ conversa: { wa_id: '5514996426132', nome_perfil: 'Jane', ad_id: '1', criado_em: '2026-10-08T20:14:00Z', handoff_em: '2026-10-08T20:43:00Z', triagem: { calculo: { renda_liquida: 760, parcelas_mensais_consideradas: 600, percentual_renda_comprometido: 78.9, sobra_mensal: 160, minimo_existencial: 600, credores_considerados: 4, saldo_total_considerado: 6000, indicativo: 'favoravel' }, resumo: 'Pensionista.' } }, mensagens: [{ direcao: 'in', texto: 'Oi', criado_em: '2026-10-08T20:14:00Z' }, { direcao: 'out', texto: 'Olá', criado_em: '2026-10-08T20:14:10Z' }], motivo: 'pediu humano' });
  for (const trecho of ['+55 14 99642-6132', 'wa.me/5514996426132', 'R$ 760,00', '78.9%', 'Pensionista.', 'Jane: Oi', 'pediu humano']) if (!b.includes(trecho)) throw new Error('briefing sem: ' + trecho);
  console.log('smoke ok (briefing)');
}
