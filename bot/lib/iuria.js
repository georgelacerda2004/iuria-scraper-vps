// Ponte com o IURIA (Supabase juridicopro): Storage, OCR, cliente, processo, Autentique.
// Tudo via service role; as edge functions aceitam o Bearer da service role.
import { db } from './db.js';

const SB_URL = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_SVC = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'documentos';

async function edge(slug, body) {
  const r = await fetch(`${SB_URL()}/functions/v1/${slug}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SB_SVC()}`, apikey: SB_SVC(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false || j?.error) throw new Error(`[iuria] ${slug}: ${j?.error || `HTTP ${r.status}`}`);
  return j;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

// Guarda o arquivo recebido no WhatsApp no bucket "documentos" do IURIA.
export async function guardarArquivo({ conversaId, slot, buffer, mime }) {
  const s = db();
  if (!s) throw new Error('[iuria] sem banco');
  const ext = EXT[mime] || 'bin';
  const path = `se-uploads/${conversaId}/${slot}_${Date.now()}.${ext}`;
  const { error } = await s.storage.from(BUCKET).upload(path, buffer, { contentType: mime, upsert: true });
  if (error) throw new Error(`[iuria] upload: ${error.message}`);
  return path;
}

// OCR + classificação pela edge classificar-doc. Devolve { tipo, dados }.
export async function classificarDoc(storagePath, mime) {
  const j = await edge('classificar-doc', { storage_path: storagePath, mime_type: mime });
  return { tipo: j.tipo || 'Outro', confianca: j.confianca, dados: j.dados_extraidos || {} };
}

export async function donoDoEscritorio(escritorioId) {
  const s = db();
  const { data } = await s.from('perfis_usuario').select('user_id').eq('escritorio_id', escritorioId).order('criado_em', { ascending: true }).limit(1).maybeSingle();
  if (!data?.user_id) throw new Error('[iuria] escritório sem usuário dono');
  return data.user_id;
}

function fmtCpf(d) { const x = (d || '').replace(/\D/g, ''); return x.length === 11 ? `${x.slice(0, 3)}.${x.slice(3, 6)}.${x.slice(6, 9)}-${x.slice(9)}` : (d || null); }
function ymd(br) { const m = (br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }

// Cria o cliente (ou acha pelo CPF dentro do escritório). Devolve a linha.
export async function criarOuAcharCliente({ dados, waId, nomePerfil, escritorioId }) {
  const s = db();
  const dono = await donoDoEscritorio(escritorioId);
  const cpf = fmtCpf(dados.cpf);
  if (cpf) {
    const { data: users } = await s.from('perfis_usuario').select('user_id').eq('escritorio_id', escritorioId);
    const ids = (users || []).map(u => u.user_id);
    const { data: ex } = await s.from('clientes').select('*').eq('cpf', cpf).in('criado_por', ids).limit(1).maybeSingle();
    if (ex) return ex;
  }
  const novo = {
    tipo_pessoa: 'PF', nome: dados.nome || nomePerfil || 'Lead Superendividamento', cpf, rg: dados.rg || null,
    nascimento: ymd(dados.data_nascimento), nacionalidade: dados.nacionalidade || 'brasileiro(a)', profissao: dados.profissao || null,
    estado_civil: dados.estado_civil || null, celular: waId, email1: dados.email || null,
    cep: dados.cep || null, uf: dados.uf || null, endereco: dados.endereco || null, bairro: dados.bairro || null, cidade: dados.cidade || null,
    grupo: 'Superendividamento', observacao: `Cadastro automático pelo robô WhatsApp (${waId}).`, criado_por: dono, aviso_whatsapp: 'manual', // coluna aceita só off|manual|auto; o número já vai em `celular`
  };
  const { data, error } = await s.from('clientes').insert(novo).select('*').single();
  if (error) throw new Error(`[iuria] criar cliente: ${error.message}`);
  return data;
}

export async function buscarCliente(id) {
  const s = db();
  if (!s || !id) return null;
  const { data } = await s.from('clientes').select('*').eq('id', id).maybeSingle();
  return data || null;
}

export async function registrarDocumento({ clienteId, nome, tipo, storagePath, mime, bytes, dados, criadoPor }) {
  const s = db();
  const { error } = await s.from('documentos').insert({
    cliente_id: clienteId, nome, tipo, storage_path: storagePath, mime_type: mime, tamanho_bytes: bytes ?? null,
    classificado_por_ia: true, dados_extraidos: dados ?? null, ia_classificado_em: new Date().toISOString(), uploaded_by: criadoPor, criado_por: criadoPor,
  });
  if (error) console.warn('[iuria] registrarDocumento:', error.message);
}

export async function criarProcesso({ cliente, escritorioId, triagem }) {
  const s = db();
  const dono = await donoDoEscritorio(escritorioId);
  const { data, error } = await s.from('processos').insert({
    cliente_id: cliente.id,
    objeto_acao: 'Repactuação de dívidas — Lei 14.181/2021 (art. 104-A do CDC)',
    tipo_processo: 'Judicial', status_processo: 'Ativo', area_atuacao: 'Cível', posicao_parte: 'Autor',
    natureza: 'Superendividamento', tribunal: process.env.TRIBUNAL_PADRAO || 'TJSP', uf: cliente.uf || 'SP', comarca: cliente.cidade || null,
    parte_adversa_texto: (triagem?.calculo ? [] : []).concat(((triagem?.credores) || []).map(c => c.credor)).join(', ') || 'Credores (ver declaração)',
    responsavel: process.env.RESPONSAVEL_NOME || process.env.ADVOGADO_NOME || null, advogado_nome: process.env.ADVOGADO_NOME || null, advogado_oab: process.env.ADVOGADO_OAB || null,
    criado_por: dono, ativo: true,
  }).select('id').single();
  if (error) throw new Error(`[iuria] criar processo: ${error.message}`);
  return data.id;
}

export async function criarEntrevista({ cliente, processoId, escritorioId, triagem, historicoTexto }) {
  const s = db();
  const dono = await donoDoEscritorio(escritorioId);
  const texto = [
    `Lead do robô WhatsApp (Superendividamento). Cliente: ${cliente.nome}, CPF ${cliente.cpf || '-'}.`,
    triagem?.resumo ? `RESUMO DA TRIAGEM: ${triagem.resumo}` : '',
    triagem?.calculo ? `CÁLCULO: renda líquida R$ ${triagem.calculo.renda_liquida}; parcelas R$ ${triagem.calculo.parcelas_mensais_consideradas}; ${triagem.calculo.percentual_renda_comprometido}% da renda; sobra mensal R$ ${triagem.calculo.sobra_mensal} (mínimo existencial R$ ${triagem.calculo.minimo_existencial}).` : '',
    'TESE: repactuação de dívidas com audiência global de conciliação (art. 104-A do CDC, Lei 14.181/2021), plano de pagamento de até 5 anos com preservação do mínimo existencial; subsidiariamente, plano judicial compulsório (art. 104-B). Foro: Vara Cível do domicílio do consumidor. Justiça gratuita.',
    historicoTexto ? `CONVERSA:\n${historicoTexto}` : '',
  ].filter(Boolean).join('\n\n');
  const { data, error } = await s.from('inicial_entrevistas').insert({
    cliente_id: cliente.id, processo_id: processoId, tipo_acao: 'Superendividamento - repactuação de dívidas (art. 104-A CDC)',
    status: 'rascunho', entrevista_texto: texto, observacoes_internas: 'Gerado pelo robô WhatsApp após pagamento e assinatura.',
    calculo_preliminar: triagem?.calculo || null, criado_por: dono,
  }).select('id').single();
  if (error) throw new Error(`[iuria] criar entrevista: ${error.message}`);
  return data.id;
}

export async function registrarHonorario({ clienteId, processoId, valorEntrada, criadoPor }) {
  const s = db();
  const { error } = await s.from('honorarios').insert({
    cliente_id: clienteId, processo_id: processoId, tipo: 'contratual', valor_total: valorEntrada, num_parcelas: 1,
    forma_pagamento: 'Asaas', status: 'pago', data_acordo: new Date().toISOString().slice(0, 10),
    observacao: 'Entrada paga via robô WhatsApp (Asaas).', criado_por: criadoPor,
  });
  if (error) console.warn('[iuria] registrarHonorario:', error.message);
}

// Dispara 1 PDF para assinatura via edge autentique-enviar (link, sem custo de WhatsApp).
export async function enviarParaAssinatura({ tipoDoc, nomeDoc, clienteId, processoId, pdfBase64, nomeSignatario }) {
  const j = await edge('autentique-enviar', {
    tipo_doc: tipoDoc, nome_doc: nomeDoc, cliente_id: clienteId, processo_id: processoId ?? null, pdf_base64: pdfBase64,
    signers: [{ name: nomeSignatario, deliver_via: 'LINK', action: 'SIGN' }],
  });
  return { autentiqueId: j.autentique_id, link: j.link_curto };
}

export async function statusAssinaturas(autentiqueIds) {
  const s = db();
  const { data, error } = await s.from('assinaturas').select('autentique_id,status,tipo_doc').in('autentique_id', autentiqueIds);
  if (error) throw new Error(`[iuria] statusAssinaturas: ${error.message}`);
  return data || [];
}

// Aviso ao operador (George) pelo Telegram, best-effort.
export async function avisarOperador(texto) {
  const tk = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tk || !chat) { console.log('[aviso]', texto); return; }
  try {
    await fetch(`https://api.telegram.org/bot${tk}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto }) });
  } catch (e) { console.warn('[aviso] telegram falhou:', e.message); }
}
