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
  { slot: 'renda', pede: 'Perfeito. Agora um *comprovante de renda*: holerite, extrato do INSS ou extrato bancário dos últimos 3 meses.', aceita: /renda|holerite|extrato|imposto|ctps/i },
  // Vários arquivos: a pessoa manda quantos tiver e encerra com "pronto" (ou "pular" se não tiver agora).
  { slot: 'dividas', multi: true, pede: 'Por último, os *comprovantes das dívidas*: fatura do cartão, extrato do empréstimo, contrato, tela do app do banco ou carta de cobrança. Pode mandar vários, um por mensagem. Quando terminar, escreva *pronto*. Se não tiver nada agora, escreva *pular*.', aceita: /./ },
];
// Tipos aceitos pela tabela documentos do IURIA; o resto vira "Outro".
const TIPOS_IURIA = new Set(['RG / CPF', 'CNH', 'CPF', 'RG', 'Comprovante de residência', 'Comprovante de renda', 'CTPS', 'Holerite', 'Imposto de Renda', 'Extrato bancário', 'Procuração', 'Contrato de honorários', 'Contrato', 'Boleto', 'Recibo', 'Nota fiscal', 'Outro']);
const tipoIuria = (t) => TIPOS_IURIA.has(t) ? t : 'Outro';
const NOME_ROBO = () => process.env.NOME_ROBO || 'Paula';
// Forma da entrada combinada na proposta: 'agora' (cobrança Asaas), 'apos_liminar' ou 'ad_exitum' (sem entrada).
export const modoEntrada = (triagem) => ['apos_liminar', 'ad_exitum'].includes((triagem || {}).pagamento) ? triagem.pagamento : 'agora';
export const pagamentoDiferido = (triagem) => modoEntrada(triagem) !== 'agora';
const ENTRADA = () => Number(process.env.HONORARIOS_ENTRADA || 500);
const soDigitos = v => String(v || '').replace(/\D/g, '');
// CPF: 11 dígitos, não repetidos, com os dois dígitos verificadores corretos.
export function cpfValido(v) {
  const d = soDigitos(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => { let soma = 0; for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i); const r = (soma * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

export const MSG = {
  inicioDocs: (nome) => `${nome ? nome.split(' ')[0] + ', p' : 'P'}elo que você me contou, sua situação tem sinais de se enquadrar na Lei do Superendividamento. Quem confirma isso é o advogado, e para ele analisar preciso de alguns documentos. Vamos um de cada vez.\n\n` + SLOTS[0].pede,
  primeiroDoc: 'Para o advogado analisar, preciso de alguns documentos por aqui mesmo: RG ou CNH, comprovante de endereço, comprovante de renda e o que você tiver das dívidas. Vamos um de cada vez.\n\n' + SLOTS[0].pede,
  retomada: (nome) => `${nome ? nome.split(' ')[0] + ', a' : 'A'}qui é a ${NOME_ROBO()} de novo. Já deixei o seu caso com o advogado e ele vai analisar com calma. Para isso, preciso de alguns documentos por aqui mesmo. Vamos um de cada vez.\n\n` + SLOTS[0].pede,
  naoEhDoc: (esperado) => `Esse arquivo não parece ser ${esperado}. Pode conferir e mandar de novo? Se preferir, escreva "pular" que a equipe pede depois.`,
  semArquivo: (pede) => `Preciso do arquivo (foto ou PDF) para seguir. ${pede}`,
  maisDividas: (n) => `Recebi (${n} arquivo${n > 1 ? 's' : ''} das dívidas). Pode mandar mais, ou escreva *pronto* para eu finalizar.`,
  extraGuardado: 'Recebi, guardei na sua pasta no escritório. O advogado já tem acesso.',
  processando: 'Recebi os documentos, obrigado! Estou preparando o seu cadastro e os documentos para assinatura. Leva um minutinho.',
  pedirCpf: 'Recebi os documentos, obrigado! Só não consegui ler o seu *CPF* na foto. Me manda o número do CPF (só os dígitos) para eu finalizar o cadastro.',
  linksEnvio: ({ valor, urlPagamento, docs, modo = 'agora' }) => urlPagamento
    ? `Pronto! Para seguir com o seu caso, são dois passos:\n\n` +
    `1) *Entrada dos honorários* (R$ ${valor.toFixed(2).replace('.', ',')}), por Pix, boleto ou cartão:\n${urlPagamento}\n\n` +
    `2) *Assinar pelo celular* (clique, confira e assine):\n` + docs.map((d, i) => `${i + 1}. ${d.nome}: ${d.link}`).join('\n') +
    `\n\nAssim que o pagamento e as assinaturas forem confirmados, eu aviso o advogado e ele assume. Qualquer dúvida sobre o contrato, é só perguntar.`
    : `Pronto! Como combinamos, ${modo === 'ad_exitum' ? 'não há entrada: o escritório só recebe ao final, se der certo' : `a entrada de R$ ${valor.toFixed(2).replace('.', ',')} fica para depois da liminar`}. Isso está escrito no contrato. Agora só falta *assinar pelo celular* (clique, confira e assine):\n` +
    docs.map((d, i) => `${i + 1}. ${d.nome}: ${d.link}`).join('\n') +
    `\n\nAssim que as assinaturas forem confirmadas, eu aviso o advogado e ele assume. Qualquer dúvida sobre o contrato, é só perguntar.`,
  semAssinaturaAinda: ({ valor, urlPagamento, modo }) => (urlPagamento
    ? `Pronto! Seu cadastro está feito. Primeiro passo, a *entrada dos honorários* (R$ ${valor.toFixed(2).replace('.', ',')}), por Pix, boleto ou cartão:\n${urlPagamento}\n\n`
    : `Pronto! Seu cadastro está feito. Como combinamos, ${modo === 'ad_exitum' ? 'não há entrada' : 'a entrada fica para depois da liminar'}.\n\n`) +
    `Os documentos para *assinar pelo celular* (procuração, contrato e declarações) chegam em seguida por aqui, assim que o sistema de assinatura liberar. Eu te mando os links.`,
  linksAssinatura: (nome, docs) => `${nome ? nome.split(' ')[0] + ', c' : 'C'}hegaram os seus documentos para *assinar pelo celular* (clique, confira e assine):\n` + docs.map((d, i) => `${i + 1}. ${d.nome}: ${d.link}`).join('\n') + `\n\nQualquer dúvida sobre o contrato, é só perguntar.`,
  aguardando: ({ pago, assinados, total, diferido, modo }) => `Status: ${diferido ? (modo === 'ad_exitum' ? 'sem entrada (ad exitum)' : 'entrada combinada para depois da liminar') : `pagamento ${pago ? 'confirmado ✅' : 'pendente'}`}; assinaturas ${assinados}/${total}. ${(pago || diferido) && assinados === total ? 'Tudo certo!' : 'Quando concluir, eu sigo automaticamente.'}`,
  concluido: (nome, diferido) => `${nome ? nome.split(' ')[0] + ', t' : 'T'}udo confirmado: ${diferido ? 'documentos assinados' : 'pagamento e documentos assinados'}. Seu caso já está cadastrado e o advogado vai revisar e entrar em contato por aqui. Se tiver extratos ou contratos das dívidas, pode mandar por aqui que eu guardo na sua pasta.`,
  erro: 'Tive um problema ao processar. Já avisei a equipe; eles continuam com você por aqui.',
};

export function pedidoPendente(triagem) { const s = slotAtual(triagem); return s ? s.pede : null; }
export function slotAtual(triagem) {
  const recebidos = triagem?.documentos || {};
  // Slot múltiplo (dívidas): os arquivos vão para `dividas_pendentes` e só viram `dividas` com "pronto" (ou [] com "pular").
  return SLOTS.find(s => recebidos[s.slot] === undefined) || null;
}

// Arquivo recebido depois da contratação (etapa cliente): guarda na pasta e registra no IURIA.
export async function guardarExtra(conversa, ev, deps = {}) {
  const { baixar = downloadMedia, guardar = iuria.guardarArquivo, classificar = iuria.classificarDoc, registrarDoc = iuria.registrarDocumento } = deps;
  const triagem = conversa.triagem || {};
  const { buffer, mime } = await baixar(ev.mediaId);
  const path = await guardar({ conversaId: conversa.id, slot: 'dividas', buffer, mime });
  let cls = { tipo: 'Outro', dados: {} };
  try { cls = await classificar(path, mime); } catch { /* sem OCR */ }
  const lista = [...(Array.isArray(triagem.documentos?.dividas) ? triagem.documentos.dividas : []), { path, mime, tipo: cls.tipo, bytes: buffer.length, credor: cls.dados?.credor || null, pos_contratacao: true }];
  if (conversa.cliente_id) await registrarDoc({ clienteId: conversa.cliente_id, nome: `dívida ${lista.length} (robô WhatsApp)`, tipo: tipoIuria(cls.tipo), storagePath: path, mime, bytes: buffer.length, dados: null, criadoPor: null }).catch(e => console.warn('[captacao] registrarDoc extra:', e.message));
  return { respostas: [MSG.extraGuardado], patch: { triagem: { ...triagem, documentos: { ...(triagem.documentos || {}), dividas: lista }, docs_dividas: lista.length } } };
}

// Recebe um evento na etapa 'docs'. Devolve { respostas, patch, acao? }.
export async function receberDocumento(conversa, ev, deps = {}) {
  const { baixar = downloadMedia, guardar = iuria.guardarArquivo, classificar = iuria.classificarDoc } = deps;
  const triagem = conversa.triagem || {};
  const atual = slotAtual(triagem);
  if (!atual) {
    // Documentos completos: falta só o CPF (OCR não leu). Aceita o número por texto.
    const d = { ...(triagem.dados || {}) };
    if (cpfValido(d.cpf)) return { respostas: [], patch: {}, acao: 'concluir' };
    const digs = soDigitos(ev.texto);
    if (!ev.mediaId && cpfValido(digs)) return { respostas: [MSG.processando], patch: { triagem: { ...triagem, dados: { ...d, cpf: digs } } }, acao: 'concluir' };
    return { respostas: [MSG.pedirCpf], patch: {} };
  }

  const texto = (ev.texto || '').trim();
  if (!ev.mediaId) {
    const pendentes = Array.isArray(triagem.documentos?.[atual.slot + '_pendentes']) ? triagem.documentos[atual.slot + '_pendentes'] : [];
    const encerraMulti = atual.multi && /^(pronto|pular)$/i.test(texto);
    if (/^pular$/i.test(texto) || encerraMulti) {
      const docs = { ...(triagem.documentos || {}) };
      if (atual.multi) { docs[atual.slot] = pendentes; delete docs[atual.slot + '_pendentes']; }
      else docs[atual.slot] = { pulado: true };
      const prox = slotAtual({ documentos: docs });
      const t2 = { ...triagem, documentos: docs, docs_dividas: Array.isArray(docs.dividas) ? docs.dividas.length : 0 };
      if (!prox && !cpfValido(triagem.dados?.cpf)) return { respostas: [MSG.pedirCpf], patch: { triagem: t2 } };
      return { respostas: [prox ? prox.pede : MSG.processando], patch: { triagem: t2 }, acao: prox ? null : 'concluir' };
    }
    return { respostas: [MSG.semArquivo(atual.pede)], patch: {} };
  }

  const { buffer, mime } = await baixar(ev.mediaId);
  const path = await guardar({ conversaId: conversa.id, slot: atual.slot, buffer, mime });
  let cls = { tipo: 'Outro', dados: {} };
  try { cls = await classificar(path, mime); } catch (e) { console.warn('[captacao] OCR falhou:', e.message); }

  // Comprovantes das dívidas: acumula numa lista e espera "pronto".
  if (atual.multi) {
    const chave = atual.slot + '_pendentes';
    const lista = [...(Array.isArray(triagem.documentos?.[chave]) ? triagem.documentos[chave] : []), { path, mime, tipo: cls.tipo, bytes: buffer.length, credor: cls.dados?.credor || null }];
    return { respostas: [MSG.maisDividas(lista.length)], patch: { triagem: { ...triagem, documentos: { ...(triagem.documentos || {}), [chave]: lista } } } };
  }

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
  if (!cpfValido(dados.cpf)) return { respostas: [MSG.pedirCpf], patch };
  return { respostas: [MSG.processando], patch, acao: 'concluir' };
}

// Reemite os documentos para assinatura (ex.: contrato com cláusula nova) para quem ainda não assinou.
// Os links antigos ficam registrados em triagem.assinaturas_antigas. Devolve { respostas, patch }.
export async function reemitirDocumentos(conversa, deps = {}) {
  const { buscarCliente = iuria.buscarCliente, gerar = gerarTodos, enviar = iuria.enviarParaAssinatura } = deps;
  const triagem = conversa.triagem || {};
  const cliente = await buscarCliente(conversa.cliente_id);
  if (!cliente) throw new Error('[captacao] cliente não encontrado para reemitir');
  const pdfs = await gerar(cliente, triagem);
  const docs = [];
  for (const d of pdfs) {
    const r = await enviar({ tipoDoc: d.tipo, nomeDoc: d.nome, clienteId: cliente.id, processoId: null, pdfBase64: d.pdf.toString('base64'), nomeSignatario: cliente.nome });
    docs.push({ tipo: d.tipo, nome: d.nome, autentiqueId: r.autentiqueId, link: r.link });
  }
  const nome = (conversa.nome_perfil || '').split(' ')[0];
  const texto = `${nome ? nome + ', a' : 'A'}qui é a ${NOME_ROBO()}. Atualizei os seus documentos com condições de honorários mais claras e mais leves: o êxito agora é calculado só sobre o que você economizar por mês, parcelado, e nunca passa de um quarto do alívio. Os links anteriores perdem a validade. Assine por aqui, pelo celular:\n` +
    docs.map((d, i) => `${i + 1}. ${d.nome}: ${d.link}`).join('\n') + `\n\nQualquer dúvida sobre o contrato, me pergunta.`;
  const { reemitir, ...resto } = triagem;
  return { respostas: [texto], patch: { assinado_em: null, triagem: { ...resto, assinaturas: docs, assinaturas_antigas: [...(triagem.assinaturas_antigas || []), ...(triagem.assinaturas || [])], reemitido_em: new Date().toISOString() } } };
}

// Cadastro no IURIA + cobrança + documentos para assinatura. Devolve { respostas, patch }.
export async function concluirCadastro(conversa, deps = {}) {
  const { criarCliente = iuria.criarOuAcharCliente, registrarDoc = iuria.registrarDocumento, gerar = gerarTodos, enviar = iuria.enviarParaAssinatura, asaasCliente = asaas.garantirCliente, asaasCobranca = asaas.criarCobranca } = deps;
  const triagem = conversa.triagem || {};
  const escritorioId = process.env.ESCRITORIO_ID;
  if (!escritorioId) throw new Error('[captacao] ESCRITORIO_ID ausente');

  const cliente = await criarCliente({ dados: triagem.dados || {}, waId: conversa.wa_id, nomePerfil: conversa.nome_perfil, escritorioId });
  for (const [slot, d] of Object.entries(triagem.documentos || {})) {
    const lista = Array.isArray(d) ? d : [d];
    for (const [i, x] of lista.entries()) if (x?.path) await registrarDoc({ clienteId: cliente.id, nome: `${slot}${lista.length > 1 ? ' ' + (i + 1) : ''} (robô WhatsApp)`, tipo: tipoIuria(x.tipo), storagePath: x.path, mime: x.mime, bytes: x.bytes, dados: null, criadoPor: cliente.criado_por });
  }

  // Entrada agora (cobrança Asaas) ou combinada para depois da liminar (sem cobrança; vai no contrato).
  const diferido = pagamentoDiferido(triagem);
  const referencia = `SE|${conversa.id}`;
  let cobranca = null;
  if (!diferido) {
    const customerId = await asaasCliente({ nome: cliente.nome, cpf: cliente.cpf, celular: conversa.wa_id, email: cliente.email1 });
    cobranca = await asaasCobranca({ customerId, valor: ENTRADA(), referencia, descricao: 'Entrada de honorários — análise e repactuação de dívidas (Lei 14.181/2021)' });
  }

  // Assinaturas: se o Autentique falhar (ex.: sem créditos), o cadastro segue e o robô reenvia a cada ciclo (verificarConclusao).
  let docs = [], assinaturasErro = null;
  try { docs = await enviarAssinaturas(cliente, triagem, { gerar, enviar }); }
  catch (e) { assinaturasErro = e.message; console.error('[captacao] assinaturas adiadas:', e.message); }

  const respostas = docs.length
    ? [MSG.linksEnvio({ valor: ENTRADA(), urlPagamento: cobranca?.url || null, docs, modo: modoEntrada(triagem) })]
    : [MSG.semAssinaturaAinda({ valor: ENTRADA(), urlPagamento: cobranca?.url || null, modo: modoEntrada(triagem) })];
  return {
    respostas,
    patch: { etapa: 'pagamento_assinatura', cliente_id: cliente.id, asaas_payment_id: cobranca?.id || null, triagem: { ...triagem, cobranca: cobranca ? { id: cobranca.id, url: cobranca.url, referencia } : { diferida: true, referencia }, assinaturas: docs, assinaturas_erro: assinaturasErro } },
  };
}

// Gera os PDFs e envia cada um ao Autentique. Lança erro se qualquer envio falhar.
export async function enviarAssinaturas(cliente, triagem, { gerar = gerarTodos, enviar = iuria.enviarParaAssinatura } = {}) {
  const pdfs = await gerar(cliente, triagem);
  const docs = [];
  for (const d of pdfs) {
    const r = await enviar({ tipoDoc: d.tipo, nomeDoc: d.nome, clienteId: cliente.id, processoId: null, pdfBase64: d.pdf.toString('base64'), nomeSignatario: cliente.nome });
    docs.push({ tipo: d.tipo, nome: d.nome, autentiqueId: r.autentiqueId, link: r.link });
  }
  return docs;
}

// Checa pagamento + assinaturas de uma conversa. Devolve null (nada mudou) ou { respostas, patch }.
export async function verificarConclusao(conversa, deps = {}) {
  const { consultarPagamento = asaas.consultarPorReferencia, statusAss = iuria.statusAssinaturas, criarProcesso = iuria.criarProcesso, criarEntrevista = iuria.criarEntrevista, honorario = iuria.registrarHonorario, avisar = iuria.avisarOperador, cliente } = deps;
  const triagem = conversa.triagem || {};
  const patch = {};
  const diferido = pagamentoDiferido(triagem);
  let pago = !!conversa.pago_em;
  if (!pago && !diferido) {
    const r = await consultarPagamento(triagem.cobranca?.referencia || `SE|${conversa.id}`);
    if (r.pago) { pago = true; patch.pago_em = new Date().toISOString(); }
  }
  // Assinaturas que ficaram adiadas (Autentique indisponível na hora do cadastro): tenta de novo a cada ciclo.
  if (!(triagem.assinaturas || []).length && triagem.assinaturas_erro) {
    try {
      const c0 = cliente || await (deps.buscarCliente || iuria.buscarCliente)(conversa.cliente_id);
      const docs = await enviarAssinaturas(c0, triagem, { gerar: deps.gerar, enviar: deps.enviar });
      const t2 = { ...triagem, assinaturas: docs, assinaturas_erro: null };
      return { respostas: [MSG.linksAssinatura(conversa.nome_perfil, docs)], patch: { ...patch, triagem: t2 } };
    } catch (e) { console.warn('[captacao] assinaturas ainda indisponíveis:', conversa.wa_id, e.message); return Object.keys(patch).length ? { respostas: [], patch } : null; }
  }
  const ids = (triagem.assinaturas || []).map(a => a.autentiqueId).filter(Boolean);
  const st = ids.length ? await statusAss(ids) : [];
  const assinados = st.filter(s => s.status === 'assinado').length;
  const total = ids.length;
  const tudoAssinado = total > 0 && assinados === total;
  if (tudoAssinado && !conversa.assinado_em) patch.assinado_em = new Date().toISOString();

  if (!((pago || diferido) && tudoAssinado)) return Object.keys(patch).length ? { respostas: [], patch } : null;

  const cli = cliente || (deps.buscarCliente || iuria.buscarCliente)(conversa.cliente_id).then(c => c || { id: conversa.cliente_id, nome: conversa.nome_perfil });
  const c = await cli;
  const processoId = await criarProcesso({ cliente: c, escritorioId: process.env.ESCRITORIO_ID, triagem });
  await honorario({ clienteId: c.id, processoId, valorEntrada: ENTRADA(), diferido, modo: modoEntrada(triagem), criadoPor: c.criado_por || null });
  const entrevistaId = await criarEntrevista({ cliente: c, processoId, escritorioId: process.env.ESCRITORIO_ID, triagem, historicoTexto: deps.historicoTexto || '' }).catch(e => { console.warn('[captacao] entrevista:', e.message); return null; });
  await avisar(`NOVO CLIENTE SUPERENDIVIDAMENTO ✅\n${conversa.nome_perfil || conversa.wa_id} (${conversa.wa_id})\n${diferido ? (modoEntrada(triagem) === 'ad_exitum' ? 'Contrato AD EXITUM, sem entrada' : 'Entrada combinada para depois da liminar (sem cobrança; cláusula no contrato)') : 'Entrada paga'} e 3 documentos assinados. Processo criado no IURIA (${processoId}). Gerando a petição; aviso quando a distribuição estiver em rascunho para você revisar.\nResumo: ${triagem.resumo || '-'}`);
  // Petição + rascunho de distribuição em segundo plano (a IA leva minutos). Nunca protocola.
  const preparar = deps.preparar || prepararProtocolo;
  preparar({ conversa, cliente: c, processoId, entrevistaId, escritorioId: process.env.ESCRITORIO_ID, historicoTexto: deps.historicoTexto || '' })
    .then(r => avisar(`PETIÇÃO PRONTA PARA REVISÃO — ${c.nome}\nDistribuição em rascunho (${r.distribuicaoId || 'sem id'}) no IURIA. Falta: exportar o PDF da petição, completar CNPJ dos credores e assinar com o A3.${r.viabilidade?.fundamento_resumo ? '\nViabilidade (IA): ' + r.viabilidade.fundamento_resumo : ''}`))
    .catch(e => avisar(`FALHA ao gerar a petição de ${c.nome}: ${e.message}. A entrevista está no IURIA para gerar manualmente.`));
  return { respostas: [MSG.concluido(conversa.nome_perfil, diferido)], patch: { ...patch, etapa: 'cliente', processo_id: processoId } };
}
