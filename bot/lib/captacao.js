// Etapas depois da triagem: documentos pelo chat → cadastro no IURIA → cobrança Asaas
// + 3 documentos no Autentique → (pago e assinado) → processo + entrevista → aviso ao advogado.
// Determinístico (sem IA): aqui o robô só coleta, confere e dispara.
import { downloadMedia } from './whatsapp.js';
import * as iuria from './iuria.js';
import * as asaas from './asaas.js';
import { gerarTodos } from './documentos.js';
import { prepararProtocolo } from './peticao.js';

const SLOTS = [
  { slot: 'pessoal', pede: 'Agora preciso de uma foto do seu *RG ou CNH* (frente e verso na mesma foto, ou em duas mensagens). Pode mandar como foto ou PDF.', aceita: /RG|CNH|CPF/i },
  { slot: 'endereco', pede: 'Recebi! Agora um *comprovante de endereço* recente (conta de luz, água ou telefone), no seu nome ou de quem mora com você.', aceita: /resid|endere/i },
  { slot: 'renda', pede: 'Perfeito. Por último, um *comprovante de renda*: holerite, extrato do INSS ou extrato bancário dos últimos 3 meses.', aceita: /renda|holerite|extrato|imposto|ctps/i },
];
const ENTRADA = () => Number(process.env.HONORARIOS_ENTRADA || 500);

export const MSG = {
  inicioDocs: (nome) => `${nome ? nome.split(' ')[0] + ', p' : 'P'}elo que você me contou, sua situação tem sinais de se enquadrar na Lei do Superendividamento. Quem confirma isso é o advogado, e para ele analisar preciso de 3 documentos. Vamos um de cada vez.\n\n` + SLOTS[0].pede,
  naoEhDoc: (esperado) => `Esse arquivo não parece ser ${esperado}. Pode conferir e mandar de novo? Se preferir, escreva "pular" que a equipe pede depois.`,
  semArquivo: (pede) => `Preciso do arquivo (foto ou PDF) para seguir. ${pede}`,
  processando: 'Recebi os 3 documentos, obrigado! Estou preparando o seu cadastro e os documentos para assinatura. Leva um minutinho.',
  linksEnvio: ({ valor, urlPagamento, docs }) =>
    `Pronto! Para seguir com o seu caso, são dois passos:\n\n` +
    `1) *Entrada dos honorários* (R$ ${valor.toFixed(2).replace('.', ',')}), por Pix, boleto ou cartão:\n${urlPagamento}\n\n` +
    `2) *Assinar pelo celular* (clique, confira e assine):\n` + docs.map((d, i) => `${i + 1}. ${d.nome}: ${d.link}`).join('\n') +
    `\n\nAssim que o pagamento e as assinaturas forem confirmados, eu aviso o advogado e ele assume. Qualquer dúvida sobre o contrato, é só perguntar.`,
  aguardando: ({ pago, assinados, total }) => `Status: pagamento ${pago ? 'confirmado ✅' : 'pendente'}; assinaturas ${assinados}/${total}. ${pago && assinados === total ? 'Tudo certo!' : 'Quando concluir, eu sigo automaticamente.'}`,
  concluido: (nome) => `${nome ? nome.split(' ')[0] + ', t' : 'T'}udo confirmado: pagamento e documentos assinados. Seu caso já está cadastrado e o advogado vai revisar e entrar em contato por aqui. Se tiver extratos ou contratos das dívidas, pode mandar por aqui que eu guardo na sua pasta.`,
  erro: 'Tive um problema ao processar. Já avisei a equipe; eles continuam com você por aqui.',
};

function slotAtual(triagem) {
  const recebidos = triagem?.documentos || {};
  return SLOTS.find(s => !recebidos[s.slot]) || null;
}

// Recebe um evento na etapa 'docs'. Devolve { respostas, patch, acao? }.
export async function receberDocumento(conversa, ev, deps = {}) {
  const { baixar = downloadMedia, guardar = iuria.guardarArquivo, classificar = iuria.classificarDoc } = deps;
  const triagem = conversa.triagem || {};
  const atual = slotAtual(triagem);
  if (!atual) return { respostas: [], patch: {}, acao: 'concluir' };

  const texto = (ev.texto || '').trim();
  if (!ev.mediaId) {
    if (/^pular$/i.test(texto)) {
      const docs = { ...(triagem.documentos || {}), [atual.slot]: { pulado: true } };
      const prox = slotAtual({ documentos: docs });
      return { respostas: [prox ? prox.pede : MSG.processando], patch: { triagem: { ...triagem, documentos: docs } }, acao: prox ? null : 'concluir' };
    }
    return { respostas: [MSG.semArquivo(atual.pede)], patch: {} };
  }

  const { buffer, mime } = await baixar(ev.mediaId);
  const path = await guardar({ conversaId: conversa.id, slot: atual.slot, buffer, mime });
  let cls = { tipo: 'Outro', dados: {} };
  try { cls = await classificar(path, mime); } catch (e) { console.warn('[captacao] OCR falhou:', e.message); }

  // Frente/verso do RG em duas fotos: a segunda foto do mesmo slot só complementa os dados.
  if (atual.slot === 'pessoal' && !atual.aceita.test(cls.tipo) && cls.tipo !== 'Outro') {
    return { respostas: [MSG.naoEhDoc('RG ou CNH')], patch: {} };
  }
  const dados = { ...(triagem.dados || {}) };
  for (const [k, v] of Object.entries(cls.dados || {})) if (v && !dados[k]) dados[k] = v;
  const docs = { ...(triagem.documentos || {}), [atual.slot]: { path, mime, tipo: cls.tipo, bytes: buffer.length } };
  const prox = slotAtual({ documentos: docs });
  const patch = { triagem: { ...triagem, dados, documentos: docs } };
  if (prox) return { respostas: [prox.pede], patch };
  return { respostas: [MSG.processando], patch, acao: 'concluir' };
}

// Cadastro no IURIA + cobrança + documentos para assinatura. Devolve { respostas, patch }.
export async function concluirCadastro(conversa, deps = {}) {
  const { criarCliente = iuria.criarOuAcharCliente, registrarDoc = iuria.registrarDocumento, gerar = gerarTodos, enviar = iuria.enviarParaAssinatura, asaasCliente = asaas.garantirCliente, asaasCobranca = asaas.criarCobranca } = deps;
  const triagem = conversa.triagem || {};
  const escritorioId = process.env.ESCRITORIO_ID;
  if (!escritorioId) throw new Error('[captacao] ESCRITORIO_ID ausente');

  const cliente = await criarCliente({ dados: triagem.dados || {}, waId: conversa.wa_id, nomePerfil: conversa.nome_perfil, escritorioId });
  for (const [slot, d] of Object.entries(triagem.documentos || {})) {
    if (d?.path) await registrarDoc({ clienteId: cliente.id, nome: `${slot} (robô WhatsApp)`, tipo: d.tipo || 'Outro', storagePath: d.path, mime: d.mime, bytes: d.bytes, dados: null, criadoPor: cliente.criado_por });
  }

  const referencia = `SE|${conversa.id}`;
  const customerId = await asaasCliente({ nome: cliente.nome, cpf: cliente.cpf, celular: conversa.wa_id, email: cliente.email1 });
  const cobranca = await asaasCobranca({ customerId, valor: ENTRADA(), referencia, descricao: 'Entrada de honorários — análise e repactuação de dívidas (Lei 14.181/2021)' });

  const pdfs = await gerar(cliente, triagem);
  const docs = [];
  for (const d of pdfs) {
    const r = await enviar({ tipoDoc: d.tipo, nomeDoc: d.nome, clienteId: cliente.id, processoId: null, pdfBase64: d.pdf.toString('base64'), nomeSignatario: cliente.nome });
    docs.push({ tipo: d.tipo, nome: d.nome, autentiqueId: r.autentiqueId, link: r.link });
  }

  return {
    respostas: [MSG.linksEnvio({ valor: ENTRADA(), urlPagamento: cobranca.url, docs })],
    patch: { etapa: 'pagamento_assinatura', cliente_id: cliente.id, asaas_payment_id: cobranca.id, triagem: { ...triagem, cobranca: { id: cobranca.id, url: cobranca.url, referencia }, assinaturas: docs } },
  };
}

// Checa pagamento + assinaturas de uma conversa. Devolve null (nada mudou) ou { respostas, patch }.
export async function verificarConclusao(conversa, deps = {}) {
  const { consultarPagamento = asaas.consultarPorReferencia, statusAss = iuria.statusAssinaturas, criarProcesso = iuria.criarProcesso, criarEntrevista = iuria.criarEntrevista, honorario = iuria.registrarHonorario, avisar = iuria.avisarOperador, cliente } = deps;
  const triagem = conversa.triagem || {};
  const patch = {};
  let pago = !!conversa.pago_em;
  if (!pago) {
    const r = await consultarPagamento(triagem.cobranca?.referencia || `SE|${conversa.id}`);
    if (r.pago) { pago = true; patch.pago_em = new Date().toISOString(); }
  }
  const ids = (triagem.assinaturas || []).map(a => a.autentiqueId).filter(Boolean);
  const st = ids.length ? await statusAss(ids) : [];
  const assinados = st.filter(s => s.status === 'assinado').length;
  const total = ids.length;
  const tudoAssinado = total > 0 && assinados === total;
  if (tudoAssinado && !conversa.assinado_em) patch.assinado_em = new Date().toISOString();

  if (!(pago && tudoAssinado)) return Object.keys(patch).length ? { respostas: [], patch } : null;

  const cli = cliente || (deps.buscarCliente || iuria.buscarCliente)(conversa.cliente_id).then(c => c || { id: conversa.cliente_id, nome: conversa.nome_perfil });
  const c = await cli;
  const processoId = await criarProcesso({ cliente: c, escritorioId: process.env.ESCRITORIO_ID, triagem });
  await honorario({ clienteId: c.id, processoId, valorEntrada: ENTRADA(), criadoPor: c.criado_por || null });
  const entrevistaId = await criarEntrevista({ cliente: c, processoId, escritorioId: process.env.ESCRITORIO_ID, triagem, historicoTexto: deps.historicoTexto || '' }).catch(e => { console.warn('[captacao] entrevista:', e.message); return null; });
  await avisar(`NOVO CLIENTE SUPERENDIVIDAMENTO ✅\n${conversa.nome_perfil || conversa.wa_id} (${conversa.wa_id})\nEntrada paga e 3 documentos assinados. Processo criado no IURIA (${processoId}). Gerando a petição; aviso quando a distribuição estiver em rascunho para você revisar.\nResumo: ${triagem.resumo || '-'}`);
  // Petição + rascunho de distribuição em segundo plano (a IA leva minutos). Nunca protocola.
  const preparar = deps.preparar || prepararProtocolo;
  preparar({ conversa, cliente: c, processoId, entrevistaId, escritorioId: process.env.ESCRITORIO_ID, historicoTexto: deps.historicoTexto || '' })
    .then(r => avisar(`PETIÇÃO PRONTA PARA REVISÃO — ${c.nome}\nDistribuição em rascunho (${r.distribuicaoId || 'sem id'}) no IURIA. Falta: exportar o PDF da petição, completar CNPJ dos credores e assinar com o A3.${r.viabilidade?.fundamento_resumo ? '\nViabilidade (IA): ' + r.viabilidade.fundamento_resumo : ''}`))
    .catch(e => avisar(`FALHA ao gerar a petição de ${c.nome}: ${e.message}. A entrevista está no IURIA para gerar manualmente.`));
  return { respostas: [MSG.concluido(conversa.nome_perfil)], patch: { ...patch, etapa: 'cliente', processo_id: processoId } };
}
