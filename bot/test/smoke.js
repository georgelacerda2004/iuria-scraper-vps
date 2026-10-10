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
for (const t of ['me passa pra um atendente', 'não quero falar com robô', 'posso falar com uma pessoa de verdade?', 'Cadê o advogado?']) { const h = await proximoPasso({ etapa: 'triagem' }, { texto: t }, { ia: async () => ({ texto: 'x' }) }); assert.equal(h.patch.etapa, 'handoff', 'deveria ser handoff: ' + t); }
for (const t of ['minha prima está me ajudando com um Advogado', 'o advogado vai olhar isso?', 'já fui no atendente do banco', 'sou uma pessoa de bem', 'antes de enviar me documentos gostaria de confirmar o nome do advogado responsável', 'o número da OAB também', 'posso saber qual advogado vai cuidar?']) { const h = await proximoPasso({ etapa: 'triagem' }, { texto: t }, { ia: async () => ({ texto: 'x' }) }); assert.notEqual(h.patch.etapa, 'handoff', 'não deveria ser handoff: ' + t); }
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
assert.equal(pdfs.length, 4); assert.equal(pdfs[3].tipo, 'se_hipossuficiencia');
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
const d3b = await receberDocumento(conv, { mediaId: 'm3', tipo: 'document' }, capDeps); conv = { ...conv, ...d3b.patch };
assert.equal(d3b.acao, undefined); assert.match(d3b.respostas[0], /comprovantes das dívidas/);
// dívidas: dois arquivos, depois "pronto" → conclui com docs_dividas = 2
let dv = await receberDocumento(conv, { mediaId: 'm4', tipo: 'image' }, capDeps); conv = { ...conv, ...dv.patch }; assert.match(dv.respostas[0], /1 arquivo das/);
dv = await receberDocumento(conv, { mediaId: 'm5', tipo: 'document' }, capDeps); conv = { ...conv, ...dv.patch }; assert.match(dv.respostas[0], /2 arquivos/);
assert.equal(conv.triagem.documentos.dividas_pendentes.length, 2);
const d3 = await receberDocumento(conv, { texto: 'pronto' }, capDeps); conv = { ...conv, ...d3.patch };
assert.equal(d3.acao, 'concluir'); assert.equal(conv.triagem.documentos.dividas.length, 2); assert.equal(conv.triagem.docs_dividas, 2); assert.equal(conv.triagem.documentos.dividas_pendentes, undefined);
assert.equal(conv.triagem.dados.endereco, 'Rua A, 10');
// "pular" sem arquivos → lista vazia e conclui
{ const c2 = { ...conv, triagem: { ...conv.triagem, documentos: { pessoal: conv.triagem.documentos.pessoal, endereco: conv.triagem.documentos.endereco, renda: conv.triagem.documentos.renda } } }; const p = await receberDocumento(c2, { texto: 'pular' }, capDeps); assert.equal(p.acao, 'concluir'); assert.deepEqual(p.patch.triagem.documentos.dividas, []); }

// --- captacao: cadastro + cobrança + assinatura (tudo simulado) ---
const enviados = [], registrados = [];
const cc = await concluirCadastro(conv, {
  criarCliente: async ({ dados }) => ({ ...clienteFake, nome: dados.nome }),
  registrarDoc: async (d) => { registrados.push(d); assert.ok(['RG', 'Comprovante de residência', 'Holerite', 'Outro'].includes(d.tipo), 'tipo fora do CHECK: ' + d.tipo); },
  asaasCliente: async () => 'cus_1',
  asaasCobranca: async ({ referencia, valor }) => { assert.equal(referencia, 'SE|c1'); assert.equal(valor, 500); return { id: 'pay_1', url: 'https://asaas/pay_1' }; },
  enviar: async ({ tipoDoc }) => { enviados.push(tipoDoc); return { autentiqueId: 'autq_' + tipoDoc, link: 'https://autentique/' + tipoDoc }; },
});
assert.equal(cc.patch.etapa, 'pagamento_assinatura');
assert.deepEqual(enviados, ['se_procuracao', 'se_contrato', 'se_declaracao', 'se_hipossuficiencia']);
assert.equal(registrados.length, 5); // 3 pessoais + 2 comprovantes de dívida
assert.match(cc.respostas[0], /https:\/\/asaas\/pay_1/);
assert.match(cc.respostas[0], /3\. Declaração/);
let cobrou = false;
const ccDif = await concluirCadastro({ ...conv, triagem: { ...conv.triagem, pagamento: 'apos_liminar' } }, {
  criarCliente: async () => clienteFake, registrarDoc: async () => {}, asaasCliente: async () => { cobrou = true; return 'x'; }, asaasCobranca: async () => { cobrou = true; return {}; },
  enviar: async ({ tipoDoc }) => ({ autentiqueId: 'a_' + tipoDoc, link: 'https://autentique/' + tipoDoc }),
});
assert.equal(cobrou, false); assert.equal(ccDif.patch.asaas_payment_id, null); assert.match(ccDif.respostas[0], /depois da liminar/); assert.doesNotMatch(ccDif.respostas[0], /asaas/);
conv = { ...conv, ...cc.patch };

// --- captacao: Autentique indisponível no cadastro → segue sem links e reenvia depois ---
{
  const sem = await concluirCadastro(conv, {
    criarCliente: async () => clienteFake, registrarDoc: async () => {}, asaasCliente: async () => 'cus_1', asaasCobranca: async () => ({ id: 'pay_2', url: 'https://asaas/pay_2' }),
    enviar: async () => { throw new Error('[iuria] autentique-enviar: Autentique: unavailable_credits'); },
  });
  assert.equal(sem.patch.etapa, 'pagamento_assinatura'); assert.deepEqual(sem.patch.triagem.assinaturas, []); assert.match(sem.patch.triagem.assinaturas_erro, /unavailable_credits/);
  assert.match(sem.respostas[0], /https:\/\/asaas\/pay_2[\s\S]*chegam em seguida/);
  const c2 = { ...conv, ...sem.patch };
  // ciclo seguinte, Autentique ainda fora → nada muda
  let v0 = await verificarConclusao(c2, { consultarPagamento: async () => ({ pago: false }), buscarCliente: async () => clienteFake, enviar: async () => { throw new Error('unavailable_credits'); } });
  assert.equal(v0, null);
  // Autentique voltou → manda os 4 links
  v0 = await verificarConclusao(c2, { consultarPagamento: async () => ({ pago: false }), buscarCliente: async () => clienteFake, enviar: async ({ tipoDoc }) => ({ autentiqueId: 'ok_' + tipoDoc, link: 'https://autentique/ok/' + tipoDoc }) });
  assert.equal(v0.patch.triagem.assinaturas.length, 4); assert.equal(v0.patch.triagem.assinaturas_erro, null); assert.match(v0.respostas[0], /Maria, chegaram os seus documentos[\s\S]*ok\/se_hipossuficiencia/);
}

// --- captacao: reemissão dos documentos (cláusula nova) ---
{
  const { reemitirDocumentos } = await import('../lib/captacao.js');
  const re = await reemitirDocumentos({ ...conv, nome_perfil: 'Maria Silva', triagem: { ...conv.triagem, reemitir: true } }, { buscarCliente: async () => clienteFake, enviar: async ({ tipoDoc }) => ({ autentiqueId: 'novo_' + tipoDoc, link: 'https://autentique/novo/' + tipoDoc }) });
  assert.equal(re.patch.triagem.assinaturas.length, 4); assert.equal(re.patch.triagem.assinaturas_antigas.length, 4); assert.equal(re.patch.triagem.reemitir, undefined);
  assert.match(re.respostas[0], /^Maria, aqui é a Paula[\s\S]*novo\/se_hipossuficiencia/);
}

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

// --- docs: pergunta no meio da coleta → IA responde e repete o pedido pendente ---
{
  let fase = null;
  const q = await proximoPasso({ etapa: 'docs', nome_perfil: 'Adriana', triagem: { documentos: { pessoal: { path: 'a' } } } }, { texto: 'qual o nome do advogado responsável?' }, { ia: async (a) => { fase = a.fase; return { texto: 'O advogado responsável é o Dr. X, OAB/SP 1.' }; } });
  assert.equal(fase, 'retomada'); assert.match(q.respostas[0], /Dr\. X[\s\S]*comprovante de endereço/); assert.deepEqual(q.patch, {});
}
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
// peça já gerada por tentativa anterior (gateway 504): não chama gerar, só monta a distribuição
let gerouDeNovo = false;
const pp2 = await prepararProtocolo({ conversa: { triagem: triagemFake }, cliente: clienteFake, processoId: 'p1', entrevistaId: 'e-gerada', escritorioId: 'esc-1', historicoTexto: '', deps: { gerar: async () => { gerouDeNovo = true; }, inserir: async () => 'dist-10', pecaPronta: { viabilidade: { tem_direito: true }, preco: null } } });
assert.equal(pp2.distribuicaoId, 'dist-10'); assert.equal(gerouDeNovo, false); assert.equal(pp2.viabilidade.tem_direito, true);

// --- credores: catálogo, valor da causa, polo passivo preenchido, correções ---
{
  const { buscarCatalogo, qualificarCredores, descreverCredor } = await import('../lib/credores.js');
  assert.equal(buscarCatalogo('cartão do Nubank').cnpj, '18.236.120/0001-58');
  assert.equal(buscarCatalogo('empréstimo Nu Financeira').cnpj, '30.680.829/0001-43');
  assert.equal(buscarCatalogo('Sicoob Cooperserv').cnpj, '05.667.301/0001-97');
  assert.equal(buscarCatalogo('Itaú Consignado').cnpj, '33.885.724/0001-19');
  assert.equal(buscarCatalogo('Loja Zé do Crédito'), null);
  const q = await qualificarCredores(['Banco Pine', 'Loja Zé do Crédito', 'Financeira X'], { pesquisar: async n => n === 'Financeira X' ? { razao_social: 'FINANCEIRA X S.A.', cnpj: '11.111.111/0001-11', endereco: 'Rua A, nº 1, Centro, Cidade/SP, CEP 00000-000', confianca: 'alta', fonte: 'https://x' } : { confianca: 'baixa' } });
  assert.equal(q[0].fonte, 'catalogo'); assert.equal(q[1].pendente, true); assert.equal(q[2].cnpj, '11.111.111/0001-11'); assert.match(q[2].fonte, /internet/);
  assert.match(descreverCredor(q[1]), /A CONFIRMAR/); assert.match(descreverCredor(q[0]), /62\.144\.175/);
  const { lerValor, montarDistribuicao, REGRAS_ESCRITORIO } = await import('../lib/peticao.js');
  assert.equal(lerValor('R$ 38.946,00'), 38946); assert.equal(lerValor('8000'), 8000); assert.equal(lerValor(''), null); assert.equal(lerValor('n/a'), null);
  assert.ok(REGRAS_ESCRITORIO.some(r => /VALOR DA CAUSA/.test(r)) && REGRAS_ESCRITORIO.some(r => /campo em branco/.test(r)));
  const dist = montarDistribuicao({ cliente: clienteFake, processoId: 'p1', entrevistaId: 'e1', triagem: { ...triagemFake, dividas: [{ credor: 'Banco Pine' }] }, escritorioId: 'esc', criadoPor: 'u', credores: q, valorCausa: 'R$ 38.946,00' });
  assert.equal(dist.valor_causa, 38946); assert.equal(dist.partes.passivo.length, 3);
  assert.equal(dist.partes.passivo[0].cnpj, '62144175000120'); assert.equal(dist.partes.passivo[0].cidade, 'São Paulo'); assert.equal(dist.partes.passivo[0].uf, 'SP'); assert.equal(dist.partes.passivo[0].cep, '04543-900');
  assert.equal(dist.partes.passivo[1].pendente, true); assert.match(dist.observacao, /ATENÇÃO: Loja Zé do Crédito/);
  // prepararProtocolo passa os credores qualificados para a IA e o valor da causa da IA para a distribuição
  let recebido = null, linhaIns = null;
  const pp3 = await prepararProtocolo({ conversa: { triagem: { ...triagemFake, dividas: [{ credor: 'Bradesco' }] } }, cliente: clienteFake, processoId: 'p1', entrevistaId: 'e1', escritorioId: 'esc-1', historicoTexto: '', deps: { qualificar: qualificarCredores, gerar: async (x) => { recebido = x; return { html: '<html>', viabilidade: { tem_direito: true, valor_estimado_causa: 'R$ 12.345,67' }, preco: 1 }; }, inserir: async (l) => { linhaIns = l; return 'dist-11'; } } });
  assert.equal(pp3.distribuicaoId, 'dist-11'); assert.equal(recebido.credores[0].cnpj, '60.746.948/0001-12'); assert.equal(linhaIns.valor_causa, 12345.67); assert.equal(linhaIns.partes.passivo[0].cidade, 'Osasco');
  const { aplicarTrocas, lerCorrecoes } = await import('../lib/correcoes.js');
  assert.deepEqual(aplicarTrocas('a ____ b', [['____', 'X'], ['zzz', 'Y']]), { html: 'a X b', trocas: 1 });
  const corr = lerCorrecoes(); assert.ok(corr.length >= 1 && corr[0].peticoes.length === 2 && corr[0].distribuicoes.length === 2 && corr[0].mensagens.length === 1);
  console.log('smoke ok (credores/valor da causa/correções)');
}

// --- pacote de protocolo: HTML -> PDF, imagem -> PDF, fila ---
{
  const { extrairBlocos, htmlParaPdf, imagemParaPdf, montarPacote } = await import('../lib/pacote.js');
  const html = `<!DOCTYPE html><html><head><style>p{}</style></head><body><div class="enderecamento">Excelentíssimo Senhor Doutor Juiz</div><p>FULANA, brasileira &amp; portadora do RG n&ordm; 1, vem propor</p><div class="titulo-acao">Ação de Repactuação em face de</div><p>BANCO X S.A.</p><div class="secao">I — DOS FATOS</div><p>1. Fato um.<br>Linha dois.</p><div class="secao">III — DOS PEDIDOS</div><ol class="pedidos"><li>pedido a;</li><li>pedido b.</li></ol><div class="fechamento">Termos em que, pede deferimento.</div><div class="assinatura"><div class="linha"></div>ADVOGADO<br>OAB/SP 1</div></body></html>`;
  const b = extrairBlocos(html);
  assert.deepEqual(b.map(x => x.tipo), ['enderecamento', 'p', 'titulo', 'p', 'secao', 'p', 'secao', 'li', 'li', 'fechamento', 'assinatura']);
  assert.equal(b[1].texto, 'FULANA, brasileira & portadora do RG nº 1, vem propor'); assert.equal(b[5].texto, '1. Fato um.\nLinha dois.'); assert.equal(b[10].texto, 'ADVOGADO\nOAB/SP 1');
  const pdf = await htmlParaPdf(html); assert.equal(pdf.subarray(0, 4).toString(), '%PDF'); assert.ok(pdf.length > 1500);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const ipdf = await imagemParaPdf(png, 'image/png'); assert.equal(ipdf.subarray(0, 4).toString(), '%PDF');
  await assert.rejects(imagemParaPdf(png, 'image/webp'), /não conversível/);
  const subidos = {};
  const r = await montarPacote({ distribuicao: { id: 'dddddddd-1111', anexos: [{ nome: 'RG', tipo: 'RG', storage_path: 'se-uploads/c1/rg.png', mime_type: 'image/png' }, { nome: 'Procuração (assinado).pdf', tipo: 'Procuração', storage_path: 'se-uploads/c1/proc.pdf', mime_type: 'application/pdf' }, { nome: 'audio', tipo: 'Outro', storage_path: 'se-uploads/c1/a.ogg', mime_type: 'audio/ogg' }] }, clienteId: 'c1', peticaoHtml: html, deps: { baixar: async () => png, subir: async (p, buf) => { subidos[p] = buf.length; return p; } } });
  assert.equal(r.pacote.length, 3); assert.equal(r.pacote[0].nome, '01-peticao-inicial.pdf'); assert.equal(r.pacote[1].origem, 'convertido'); assert.equal(r.pacote[2].origem, 'original'); assert.equal(r.pacote[2].storage_path, 'se-uploads/c1/proc.pdf');
  assert.ok(subidos['se-uploads/c1/protocolo/dddddddd/01-peticao-inicial.pdf'] > 1000); assert.equal(r.avisos.length, 1); assert.match(r.avisos[0], /audio\/ogg/);
  await assert.rejects(montarPacote({ distribuicao: { id: 'x', anexos: [] }, clienteId: 'c1', peticaoHtml: '', deps: { subir: async p => p } }), /não gerada/);
  const { montarItemFila, STATUS } = await import('../lib/protocolo.js');
  assert.deepEqual(STATUS, ['rascunho', 'pronta', 'aprovada', 'em_protocolo', 'protocolada', 'erro']);
  const item = await montarItemFila({ id: 'd1', status: 'aprovada', tribunal: 'TJSP', sistema: 'esaj', classe_nome: 'Classe', valor_causa: 8000, partes: { ativo: [], passivo: [{ nome: 'B', cnpj: '1' }] }, progresso: { pacote: r.pacote, aprovado_por: 'Dr. A', aprovado_em: 't' } }, { cliente: { nome: 'Fulana', cpf: '1', cidade: 'SP', uf: 'SP' }, assinarUrl: async p => 'https://x/' + p });
  assert.equal(item.arquivos.length, 3); assert.equal(item.arquivos[0].url, 'https://x/se-uploads/c1/protocolo/dddddddd/01-peticao-inicial.pdf'); assert.equal(item.aprovado_por, 'Dr. A'); assert.equal(item.cliente.nome, 'Fulana');
  console.log('smoke ok (pacote/protocolo)');
}

// --- eproc: foro pelo CEP, polo ativo completo, andamentos explicados, liminar deferida ---
{
  const { extrairForo, jurisdicaoPara } = await import('../lib/foro.js');
  assert.equal(extrairForo('<tr><td>Competência Cível</td><td>Foro Regional XV - Butantã</td></tr>').foro, 'Foro Regional XV - Butantã');
  assert.equal(extrairForo(JSON.stringify([{ Competencia: 'Cível', Foro: 'Foro Regional II - Santo Amaro' }])).foro, 'Foro Regional II - Santo Amaro');
  assert.equal(extrairForo('nada aqui'), null);
  assert.equal(await jurisdicaoPara({ cidade: 'Lençóis Paulista', uf: 'SP', cep: '18682-722' }), 'Foro de Lençóis Paulista');
  assert.equal(await jurisdicaoPara({ cidade: 'São Paulo', uf: 'SP', cep: '05569-010' }, { foroPorCep: async () => ({ foro: 'Foro Regional XV - Butantã' }) }), 'São Paulo - Foro Regional XV - Butantã');
  assert.equal(await jurisdicaoPara({ cidade: 'SAO PAULO', uf: 'SP', cep: '01000-000' }, { foroPorCep: async () => null }), 'São Paulo - Foro Central Cível');
  const { sexoDe, completarAtivo, montarItemFila } = await import('../lib/protocolo.js');
  assert.deepEqual(sexoDe({ nome: 'SILVANA DE BRITO SANTOS' }), { sexo: 'F', inferido: true });
  assert.deepEqual(sexoDe({ nome: 'Andre Silva' }), { sexo: 'M', inferido: true });
  assert.deepEqual(sexoDe({ nome: 'João', sexo: 'M' }), { sexo: 'M', inferido: false });
  const [a] = await completarAtivo([{ tipo_pessoa: 'PF', nome: 'CLAUDIA CELESTINO', cpf: '1', cep: '18682-722', cidade: 'Lençóis Paulista', uf: 'SP' }], { endereco: 'Praça Antônia Foganholi Paccola, nº 463', bairro: 'Jardim Maria Luiza II', cidade: 'Lençóis Paulista', uf: 'SP', cep: '18682-722' });
  assert.equal(a.logradouro, 'Praça Antônia Foganholi Paccola'); assert.equal(a.numero, '463'); assert.equal(a.bairro, 'Jardim Maria Luiza II'); assert.equal(a.sexo, 'F');
  const item = await montarItemFila({ id: 'd1', status: 'aprovada', sistema: 'eproc', partes: { ativo: [{ nome: 'SILVANA', cep: '05569-010', cidade: 'São Paulo', uf: 'SP' }], passivo: [] }, opcoes_adicionais: { intervencao_mp: false }, progresso: { pacote: [] } }, { cliente: { nome: 'SILVANA', endereco: 'Rua Frei Claude d Alberville, nº 128', bairro: 'Jardim João XXIII', cidade: 'São Paulo', uf: 'SP', cep: '05569-010' }, assinarUrl: async p => p, foro: async () => ({ foro: 'Foro Regional XV - Butantã' }) });
  assert.equal(item.jurisdicao, 'São Paulo - Foro Regional XV - Butantã'); assert.equal(item.opcoes.juizo_digital, true); assert.equal(item.partes.ativo[0].numero, '128'); assert.equal(item.partes.ativo[0].sexo, 'F');
  const { classificarRapido, textoAndamentoExplicado, classificarAndamento, tratarLiminarDeferida } = await import('../lib/andamentos.js');
  assert.equal(classificarRapido({ descricao: 'Decisão: defiro a tutela de urgência para limitar os descontos a 30%' }), 'liminar_deferida');
  assert.equal(classificarRapido({ descricao: 'Indefiro a liminar por ora' }), 'liminar_indeferida');
  assert.equal(classificarRapido({ tipo: 'Audiência designada', descricao: 'Audiência de conciliação em 20/11/2026' }), 'audiencia');
  assert.equal(classificarRapido({ descricao: 'Juntada de certidão' }), 'juntada');
  const cl = await classificarAndamento({ descricao: 'Conclusos para despacho' });
  assert.equal(cl.categoria, 'despacho');
  const txt = textoAndamentoExplicado({ nome: 'Silvana Brito', processo: { numero: '4198609-41.2026.8.26.0100' }, andamento: { data: '10/10/2026', descricao: 'Defiro a tutela' }, classe: { categoria: 'liminar_deferida', resumo_cliente: 'O juiz mandou limitar os descontos.', precisa_acao_cliente: '' }, link: 'https://x' });
  assert.match(txt, /Liminar concedida/); assert.match(txt, /limitar os descontos/); assert.match(txt, /https:\/\/x/);
  const { linkConsulta } = await import('../lib/iuria.js');
  assert.match(linkConsulta({ tribunal: 'TJSP', sistema: 'eproc', numero: '123' }, '314107778926'), /eproc1g\.tjsp\.jus\.br.*chave 314107778926/);
  assert.match(linkConsulta({ tribunal: 'TJSP' }), /esaj/);
  // liminar deferida: cobra a entrada (após liminar) com o Asaas injetado e registra no histórico da conversa
  let cobrada = null;
  const r = await tratarLiminarDeferida({ conversa: { id: 'c1', wa_id: '5511999', triagem: { pagamento: 'apos_liminar', calculo: triagemFake.calculo } }, cliente: { id: 'cl1', nome: 'Fulana', cpf: '1' }, processo: { id: 'p1', numero: '123' }, andamento: { id: 'a1', descricao: 'Defiro' }, deps: { garantirCliente: async () => 'cus_1', criarCobranca: async (x) => { cobrada = x; return { id: 'pay_1', url: 'https://asaas/x', status: 'PENDING' }; } } });
  assert.equal(cobrada.valor, 500); assert.equal(r.patch.cobranca.url, 'https://asaas/x'); assert.ok(r.patch.liminar_deferida_em);
  console.log('smoke ok (eproc/andamentos/liminar)');
}

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
  const docs = { pessoal: { path: 'a' }, endereco: { path: 'b' }, renda: { path: 'c' }, dividas: [] };
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

// --- closer: escada (após liminar → ad exitum), contrato ad exitum, honorário ---
{
  const { gerarTodos } = await import('../lib/documentos.js');
  const { concluirCadastro, modoEntrada } = await import('../lib/captacao.js');
  assert.equal(modoEntrada({ pagamento: 'ad_exitum' }), 'ad_exitum'); assert.equal(modoEntrada({}), 'agora');
  const base = { id: 'cli-1', nome: 'Maria Silva Souza', cpf: '123.456.789-09', rg: '1', endereco: 'Rua A', bairro: 'B', cidade: 'São Paulo', uf: 'SP', cep: '0', criado_por: 'u1' };
  const tri = { resumo: 'ok', fonte_renda: 'clt', calculo: { renda_liquida: 1000, parcelas_mensais_consideradas: 500, percentual_renda_comprometido: 50, sobra_mensal: 0, minimo_existencial: 600 }, dividas: [] };
  const [a, b, c] = await Promise.all([gerarTodos(base, tri), gerarTodos(base, { ...tri, pagamento: 'apos_liminar' }), gerarTodos(base, { ...tri, pagamento: 'ad_exitum' })]);
  assert.ok(new Set([a[1].pdf.length, b[1].pdf.length, c[1].pdf.length]).size === 3, 'os 3 contratos devem diferir');
  let cobrou = false, hon = null;
  const cc = await concluirCadastro({ id: 'c9', wa_id: '5511', nome_perfil: 'Maria', triagem: { ...tri, pagamento: 'ad_exitum', dados: { cpf: '12345678909' }, documentos: {} } }, {
    criarCliente: async () => base, registrarDoc: async () => {}, asaasCliente: async () => { cobrou = true; }, asaasCobranca: async () => { cobrou = true; },
    enviar: async ({ tipoDoc }) => ({ autentiqueId: 'a_' + tipoDoc, link: 'https://autentique/' + tipoDoc }),
  });
  assert.equal(cobrou, false); assert.match(cc.respostas[0], /não há entrada/);
  const { verificarConclusao } = await import('../lib/captacao.js');
  const v = await verificarConclusao({ ...{ id: 'c9', wa_id: '5511', nome_perfil: 'Maria' }, ...cc.patch }, { consultarPagamento: async () => { throw new Error('não'); }, statusAss: async (ids) => ids.map(id => ({ autentique_id: id, status: 'assinado' })), buscarCliente: async () => base, criarProcesso: async () => 'p9', criarEntrevista: async () => 'e9', honorario: async (h) => { hon = h; }, avisar: async () => {}, preparar: async () => ({}) });
  assert.equal(v.patch.etapa, 'cliente'); assert.equal(hon.modo, 'ad_exitum');
  // roteiro da proposta menciona os três degraus e as regras
  const { responder } = await import('../lib/cerebro.js');
  let sys = null;
  await responder({ historico: [], textoAtual: 'x', fase: 'proposta', api: { beta: { messages: { create: async (req) => { sys = req.system[1].text; return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'ok' }] }; } } } } });
  for (const t of ['apos_liminar', 'ad_exitum', 'Custo de não agir', 'urgência falsa']) assert.ok(sys.includes(t), 'roteiro sem ' + t);
  console.log('smoke ok (closer)');
}

// --- SDR: follow-ups ---
{
  const fu = await import('../lib/followup.js');
  const { dentroDaJanela, enviar } = await import('../lib/whatsapp.js');
  assert.equal(fu.AGENDA.length, 3);
  assert.ok(fu.AGENDA[1].depois - fu.AGENDA[0].depois >= 6 * 3600_000, 'segundo follow-up precisa de intervalo mínimo após o primeiro');
  assert.ok(dentroDaJanela(new Date(Date.now() - 3600_000).toISOString())); assert.ok(!dentroDaJanela(new Date(Date.now() - 25 * 3600_000).toISOString())); assert.ok(!dentroDaJanela(null));
  assert.match(fu.textoFixo({ etapa: 'consentimento', nome_perfil: 'Ana Lima' }), /^Oi, Ana!.*Responda \*SIM\*/s);
  assert.match(fu.textoFixo({ etapa: 'docs', nome_perfil: 'Ana', triagem: { documentos: { pessoal: {} } } }), /comprovante de endereço/);
  assert.match(fu.textoFixo({ etapa: 'pagamento_assinatura', nome_perfil: 'Ana', triagem: { assinaturas: [{ nome: 'Contrato', link: 'https://x/1' }], cobranca: { url: 'https://pay' } } }), /https:\/\/x\/1[\s\S]*https:\/\/pay/);
  assert.doesNotMatch(fu.textoFixo({ etapa: 'pagamento_assinatura', nome_perfil: 'Ana', triagem: { pagamento: 'ad_exitum', assinaturas: [], cobranca: { url: 'https://pay' } } }), /https:\/\/pay/);
  let faseVista = null;
  const t = await fu.montarTexto({ id: 'c1', etapa: 'proposta', nome_perfil: 'Ana' }, { historico: async () => [], ia: async ({ fase }) => { faseVista = fase; return { texto: 'Oi Ana, ficou no meio...' }; } });
  assert.equal(faseVista, 'retomada'); assert.match(t, /ficou no meio/);
  assert.equal(fu.pendenciaCurta({ etapa: 'docs', triagem: { documentos: { pessoal: {}, endereco: {} } } }), 'o comprovante de renda');
  assert.equal(typeof fu.horaComercial(), 'boolean');
  // enviar: fora da janela sem template aprovado → null; com template → via template
  const r0 = await enviar({ to: '1', texto: 'x', ultimaEntradaEm: null, template: 'se_retomada', params: ['Ana'], templateDisponivel: async () => false });
  assert.equal(r0, null);
  console.log('smoke ok (followup)');
}

// --- pós: protocolo e andamento; fluxo cliente usa a IA com contexto ---
{
  const pos = await import('../lib/pos.js');
  const p = { numero: '1000000-00.2026.8.26.0100', tribunal: 'TJSP', vara: '1ª Vara Cível', comarca: 'Guarulhos' };
  assert.match(pos.textoProtocolo({ nome_perfil: 'Ana Lima' }, p), /Ana, boa notícia[\s\S]*1000000-00\.2026\.8\.26\.0100[\s\S]*esaj\.tjsp/);
  const tp = pos.textoProtocolo({ nome_perfil: 'Ana Lima' }, { ...p, sistema: 'eproc' }, '314107778926', 'https://www.iuria.com.br/portal.html?token=abc');
  assert.match(tp, /portal\.html\?token=abc[\s\S]*chave \*314107778926\*[\s\S]*eproc1g/);
  assert.doesNotMatch(tp, /\(número/);
  const cc = { nome_perfil: 'Claudia Celestino', criado_em: '2026-10-08T22:11:13Z', assinado_em: '2026-10-09T12:00:00Z', triagem: { registrado_em: '2026-10-08T22:57:49Z', proposta_aceita_em: '2026-10-08T23:06:22Z', pagamento: 'apos_liminar', documentos: { pessoal: {}, renda: {}, endereco: {} }, docs_dividas: 1, docs_pendentes: 'os contratos ou extratos dos consignados do Santander e da Cooperserv' } };
  const lt = pos.linhaDoTempo(cc, { numero: '4003090-53.2026.8.26.0319', data_distribuicao: '2026-10-10' });
  assert.match(lt, /08\/10\/2026: primeiro contato[\s\S]*entrada após a liminar[\s\S]*pessoal, renda, endereco; 1 extrato[\s\S]*09\/10\/2026: assinou[\s\S]*10\/10\/2026: processo protocolado \(4003090[\s\S]*PENDENTES: os contratos/);
  assert.match(pos.textoDocsPendentes(cc, pos.docsPendentes(cc)), /Claudia, uma coisa importante[\s\S]*Santander e da Cooperserv/);
  assert.equal(pos.docsPendentes({ triagem: { docs_pendentes: 'x', docs_pendentes_resolvido_em: '2026-10-11' } }), '');
  // rodar sem andamentos: avisa protocolo + pendência e não lê andamentos
  {
    const enviados = []; let leu = false;
    const deps = { enviar: async ({ texto }) => { enviados.push(texto); return { via: 'text', texto, out: {} }; }, chave: async () => 'K1', portal: async () => 'https://p', andamentos: async () => { leu = true; return []; } };
    const antes = process.env.NODE_ENV; // db() é nulo em teste: rodar devolve zeros sem quebrar
    const r = await pos.rodar({ deps, andamentos: false });
    assert.deepEqual(r, { protocolos: 0, andamentos: 0 }); assert.equal(leu, false); process.env.NODE_ENV = antes;
  }
  assert.match(pos.textoAndamento({ nome_perfil: 'Ana' }, p, { data: '2026-10-20', tipo: 'Decisão', descricao: 'Defiro a tutela' }), /Decisão: Defiro a tutela/);
  let ctx = null, fase = null;
  const f = await proximoPasso({ etapa: 'cliente', processo_id: 'p1', nome_perfil: 'Ana' }, { texto: 'como está meu processo?' }, { resumoProcesso: async () => 'Número do processo: 123', ia: async (a) => { ctx = a.contexto; fase = a.fase; return { texto: 'Está assim...' }; } });
  assert.equal(fase, 'pos'); assert.match(ctx, /123/); assert.equal(f.respostas[0], 'Está assim...');
  const { definicoes } = await import('../lib/templates.js');
  assert.deepEqual(Object.keys(definicoes()), ['se_retomada', 'se_processo_protocolado', 'se_andamento', 'se_pendencia']);
  console.log('smoke ok (pos)');
}

// --- painel: resumo, funil, auth ---
{
  const { resumirConversa, funil, montarRouter } = await import('../lib/painel.js');
  const c = resumirConversa({ id: 'x', wa_id: '5511987654321', nome_perfil: 'Ana', etapa: 'docs', consentimento_em: 'd', triagem: { resultado: 'favoravel', pagamento: 'apos_liminar', calculo: { renda_liquida: 1000, percentual_renda_comprometido: 60, sobra_mensal: -200, indicativo: 'favoravel' }, documentos: { pessoal: {} } } });
  assert.equal(c.telefone, '(11) 98765-4321'); assert.equal(c.temperatura, 'quente');
  const { temperatura } = await import('../lib/painel.js');
  assert.equal(temperatura({ etapa: 'cliente' }).nivel, 'pronto'); assert.equal(temperatura({ etapa: 'consentimento' }).nivel, 'frio'); assert.equal(temperatura({ etapa: 'triagem', consentimento_em: 'x', triagem: { calculo: {}, resultado: 'favoravel' } }).nivel, 'morno'); assert.equal(c.pct, 60); assert.equal(c.docs, 1); assert.equal(c.rotulo, 'Mandando documentos');
  const f = funil([c, resumirConversa({ etapa: 'consentimento', wa_id: '1' })]);
  assert.equal(f.total, 2); assert.equal(f.favoraveis, 1); assert.equal(f.sem_resposta, 1); assert.equal(f.por_pagamento.apos_liminar, 1);
  const express = (await import('express')).default;
  const a = express(); a.use('/painel', montarRouter({ senha: 'abc' }));
  const srv = a.listen(0); const porta = srv.address().port;
  const r1 = await fetch(`http://127.0.0.1:${porta}/painel/api/resumo`); assert.equal(r1.status, 401);
  const r2 = await fetch(`http://127.0.0.1:${porta}/painel/`); assert.equal(r2.status, 200); assert.match(await r2.text(), /Painel Superendividamento/);
  srv.close();
  console.log('smoke ok (painel)');
}

// --- mercado de indicação: brief anonimizado, consentimento na Paula, área do parceiro ---
{
  const { montarBrief, mensagemIndicacao, ETAPAS_OFERTAVEIS, resumoBriefTexto } = await import('../lib/mercado.js');
  const c = { wa_id: '5514996426132', nome_perfil: 'Jane Souza', etapa: 'desistiu', criado_em: 'x', triagem: { resultado: 'favoravel', fonte_renda: 'aposentado_pensionista', resumo: 'Jane é pensionista; Souza tem 3 cartões.', calculo: { renda_liquida: 760, parcelas_mensais_consideradas: 600, percentual_renda_comprometido: 78.9, sobra_mensal: 160, credores_considerados: 4, saldo_total_considerado: 6000, indicativo: 'favoravel' }, dividas: [{ tipo: 'consignado', credor: 'Banco X', parcela_mensal: 600, saldo_total: 0 }] } };
  const b = montarBrief(c);
  assert.equal(b.regiao, 'Bauru/Marília (SP)'); assert.doesNotMatch(b.resumo, /Jane|Souza/); assert.match(b.resumo, /\[cliente\]/); assert.equal(b.pct, 78.9);
  assert.ok(!JSON.stringify(b).includes('5514996426132')); assert.ok(!JSON.stringify(b).includes('Jane'));
  assert.match(resumoBriefTexto(b), /Região: Bauru/);
  assert.match(mensagemIndicacao(c, { nome: 'Carlos Lima', uf: 'SP', oab: '123456', whatsapp: '11999990000' }), /^Jane, boa notícia.*Dr\(a\)\. Carlos Lima.*OAB\/SP 123456/);
  assert.ok(ETAPAS_OFERTAVEIS.includes('desistiu') && !ETAPAS_OFERTAVEIS.includes('pagamento_assinatura') && !ETAPAS_OFERTAVEIS.includes('cliente'));
  // fluxo: consentimento → oferta; não → volta; em_oferta/indicado respondem fixo; cancelar e problema
  let f = await proximoPasso({ etapa: 'consentimento_indicacao', etapa_anterior: 'desistiu', nome_perfil: 'Jane' }, { texto: 'sim' });
  assert.equal(f.oferecer, true); assert.equal(f.patch.etapa, 'em_oferta'); assert.ok(f.patch.consentimento_indicacao_em);
  f = await proximoPasso({ etapa: 'consentimento_indicacao', etapa_anterior: 'desistiu' }, { texto: 'não' }); assert.equal(f.patch.etapa, 'desistiu'); assert.ok(!f.oferecer);
  f = await proximoPasso({ etapa: 'consentimento_indicacao', etapa_anterior: 'docs' }, { texto: 'o que?' }); assert.match(f.respostas[0], /autorizar/);
  f = await proximoPasso({ etapa: 'em_oferta' }, { texto: 'oi' }); assert.match(f.respostas[0], /encaminhado/);
  f = await proximoPasso({ etapa: 'em_oferta', etapa_anterior: 'docs' }, { texto: 'cancelar indicação' }); assert.equal(f.cancelarOferta, true); assert.equal(f.patch.etapa, 'docs');
  f = await proximoPasso({ etapa: 'indicado' }, { texto: 'estou com problema com o advogado' }); assert.equal(f.patch.etapa, 'handoff');
  const { montarRouter } = await import('../lib/parceiros.js');
  const express = (await import('express')).default;
  const a = express(); a.use(express.json()); a.use('/parceiros', montarRouter());
  const srv = a.listen(0); const porta = srv.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${porta}/parceiros/api/visao`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${porta}/parceiros/api/cadastro`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: 'x' }) })).status, 400);
  assert.match(await (await fetch(`http://127.0.0.1:${porta}/parceiros/termos`)).text(), /Termo de Adesão/);
  assert.match(await (await fetch(`http://127.0.0.1:${porta}/parceiros/`)).text(), /Advogados parceiros/);
  srv.close();
  console.log('smoke ok (mercado)');
}

// --- fechamento: projeção do plano, checklist e briefing ---
{
  const { projetarPlano, checklistFechamento, briefingFechamento } = await import('../lib/plano.js');
  const t = { resultado: 'favoravel', pagamento: 'apos_liminar', resumo: 'Pensionista.', dados: { cpf: '12345678909' }, documentos: { pessoal: { path: 'a' }, endereco: { path: 'b' }, renda: { path: 'c' }, dividas: [{ path: 'd' }] }, calculo: { renda_liquida: 760, parcelas_mensais_consideradas: 600, percentual_renda_comprometido: 78.9, sobra_mensal: 160, saldo_total_considerado: 6000, credores_considerados: 4 } };
  const p = projetarPlano(t);
  assert.equal(p.parcela_proposta, 160); // min(760-600, 30% de 760=228) = 160
  assert.equal(p.prazo_meses, 38); assert.equal(p.reducao_mensal, 440); assert.equal(p.valor_da_causa, 6000); assert.equal(p.cabe_no_prazo, true);
  assert.equal(projetarPlano({}), null);
  const p2 = projetarPlano({ calculo: { renda_liquida: 3000, parcelas_mensais_consideradas: 1300, saldo_total_considerado: 90000 } });
  assert.equal(p2.parcela_proposta, 900); assert.equal(p2.prazo_meses, 60); assert.equal(p2.cabe_no_prazo, false);
  const ass = [{ nome: 'Procuração - Superendividamento', status: 'assinado' }, { nome: 'Contrato de Honorários - Superendividamento', status: 'assinado' }, { nome: 'Declaração de Superendividamento', status: 'assinado' }, { nome: 'Declaração de Hipossuficiência (Justiça Gratuita)', status: 'pendente' }];
  let ck = checklistFechamento({ conversa: { triagem: t, cliente_id: 'c', processo_id: 'p' }, assinaturas: ass, distribuicao: { id: 'abcdef12' } });
  assert.equal(ck.pronto_para_advogado, false); assert.deepEqual(ck.faltam, ['Declaração de hipossuficiência (justiça gratuita) assinada']);
  ass[3].status = 'assinado';
  ck = checklistFechamento({ conversa: { triagem: t, cliente_id: 'c', processo_id: 'p' }, assinaturas: ass, distribuicao: { id: 'abcdef12' } });
  assert.equal(ck.pronto_para_advogado, true);
  const b = briefingFechamento({ conversa: { triagem: t, nome_perfil: 'Jane' }, plano: p, checklist: ck });
  assert.match(b, /^FECHADO ✅/); assert.match(b, /R\$ 160,00\/mês/); assert.match(b, /Valor da causa: R\$ 6\.000,00/);
  // honorários: 20% de 440 x 12 = 1.056; parcela 1.056/12 = 88, abaixo do teto de 25% de 440 (110) → 12 x 88
  assert.equal(p.honorarios.total, 1056); assert.equal(p.honorarios.parcela, 88); assert.equal(p.honorarios.parcelas, 12);
  const h300 = (await import('../lib/plano.js')).honorariosProjetados(300); assert.equal(h300.total, 720); assert.equal(h300.parcela, 60);
  assert.match(b, /Honorários projetados: entrada R\$ 500,00/);
  // fluxo cliente: arquivo vira comprovante de dívida guardado
  const g = await proximoPasso({ etapa: 'cliente', cliente_id: 'cli', triagem: {} }, { mediaId: 'm9', tipo: 'image' }, { captacao: { baixar: async () => ({ buffer: Buffer.from('x'), mime: 'image/jpeg' }), guardar: async () => 'p/x.jpg', classificar: async () => ({ tipo: 'Boleto', dados: {} }), registrarDoc: async (d) => { assert.equal(d.tipo, 'Boleto'); } } });
  assert.match(g.respostas[0], /guardei/); assert.equal(g.patch.triagem.docs_dividas, 1);
  console.log('smoke ok (fechamento)');
}
