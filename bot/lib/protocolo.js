// Fila de protocolo: distribuição rascunho -> pronta (pacote de PDFs) -> aprovada (toque do advogado no painel)
// -> em_protocolo (robô do PC pegou) -> protocolada | erro. O robô nunca protocola sem a aprovação.
import { db } from './db.js';
import { montarPacote } from './pacote.js';
import { avisarOperador } from './iuria.js';

const BUCKET = 'documentos';
export const STATUS = ['rascunho', 'pronta', 'aprovada', 'em_protocolo', 'protocolada', 'erro'];

// Distribuições em rascunho cuja petição já existe: gera o pacote e marca 'pronta'. Roda periodicamente.
export async function prepararPacotes({ s = db(), limite = 5 } = {}) {
  if (!s) return [];
  const { data: dists } = await s.from('distribuicoes').select('*').eq('status', 'rascunho').not('entrevista_id', 'is', null).order('created_at', { ascending: true }).limit(limite);
  const feitas = [];
  for (const d of dists || []) {
    try {
      const { data: e } = await s.from('inicial_entrevistas').select('peticao_html,status').eq('id', d.entrevista_id).maybeSingle();
      if (!e?.peticao_html) continue;
      const { pacote, avisos } = await montarPacote({ distribuicao: d, clienteId: d.cliente_id, peticaoHtml: e.peticao_html });
      const progresso = { ...(d.progresso || {}), etapa: 'pacote_pronto', pacote, avisos, pacote_em: new Date().toISOString() };
      const { error } = await s.from('distribuicoes').update({ status: 'pronta', progresso }).eq('id', d.id);
      if (error) throw new Error(error.message);
      const { data: cli } = await s.from('clientes').select('nome').eq('id', d.cliente_id).maybeSingle();
      await avisarOperador(`PRONTO PARA PROTOCOLAR — ${cli?.nome || d.cliente_id}\n${pacote.length} PDF(s) montados (petição + anexos). Valor da causa R$ ${Number(d.valor_causa || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.${avisos.length ? '\nAvisos: ' + avisos.join('; ') : ''}\nPara protocolar: abrir o painel, conferir e tocar em "Aprovar e protocolar". O robô do escritório faz o resto.`);
      feitas.push(d.id);
    } catch (e) { console.error('[protocolo] pacote', d.id, e.message); }
  }
  return feitas;
}

// Toque do advogado: só sai de 'pronta' (ou 'erro', para tentar de novo).
export async function aprovar(distribuicaoId, { s = db(), por = 'painel' } = {}) {
  const { data: d } = await s.from('distribuicoes').select('id,status,progresso').eq('id', distribuicaoId).maybeSingle();
  if (!d) throw new Error('distribuição não encontrada');
  if (!['pronta', 'erro'].includes(d.status)) throw new Error(`não dá para aprovar em "${d.status}"`);
  const progresso = { ...(d.progresso || {}), etapa: 'aprovada', aprovado_por: por, aprovado_em: new Date().toISOString() };
  const { error } = await s.from('distribuicoes').update({ status: 'aprovada', progresso }).eq('id', d.id);
  if (error) throw new Error(error.message);
  return progresso;
}

export async function reabrir(distribuicaoId, { s = db() } = {}) {
  const { data: d } = await s.from('distribuicoes').select('id,status,progresso').eq('id', distribuicaoId).maybeSingle();
  if (!d) throw new Error('distribuição não encontrada');
  if (!['aprovada', 'erro'].includes(d.status)) throw new Error(`não dá para reabrir em "${d.status}"`);
  const { error } = await s.from('distribuicoes').update({ status: 'pronta', progresso: { ...(d.progresso || {}), etapa: 'pacote_pronto' } }).eq('id', d.id);
  if (error) throw new Error(error.message);
}

// O que o robô do PC precisa para preencher o e-SAJ: dados da distribuição + links assinados dos PDFs (1 h).
export async function montarItemFila(d, { s = db(), cliente = null, assinarUrl } = {}) {
  const assinar = assinarUrl || (async p => { const { data, error } = await s.storage.from(BUCKET).createSignedUrl(p, 3600); if (error) throw new Error(error.message); return data.signedUrl; });
  const arquivos = [];
  for (const p of d.progresso?.pacote || []) arquivos.push({ ...p, url: await assinar(p.storage_path) });
  return {
    distribuicao_id: d.id, status: d.status, tribunal: d.tribunal, sistema: d.sistema, grau: d.grau,
    classe: d.classe_nome, classe_codigo: d.classe_codigo, assuntos: d.assuntos, competencia: d.competencia, area: d.area_direito,
    jurisdicao: d.jurisdicao, comarca: d.comarca, valor_causa: d.valor_causa, justica_gratuita: d.justica_gratuita, tutela_liminar: d.tutela_liminar,
    prioridade: d.prioridade, segredo_justica: d.segredo_justica, opcoes: d.opcoes_adicionais, partes: d.partes,
    cliente: cliente ? { nome: cliente.nome, cpf: cliente.cpf, cidade: cliente.cidade, uf: cliente.uf } : null,
    arquivos, aprovado_em: d.progresso?.aprovado_em || null, aprovado_por: d.progresso?.aprovado_por || null,
  };
}

export async function fila({ s = db(), status = ['aprovada', 'em_protocolo'] } = {}) {
  const { data: dists } = await s.from('distribuicoes').select('*').in('status', status).order('updated_at', { ascending: true }).limit(20);
  const out = [];
  for (const d of dists || []) {
    const { data: cli } = await s.from('clientes').select('nome,cpf,cidade,uf').eq('id', d.cliente_id).maybeSingle();
    out.push(await montarItemFila(d, { s, cliente: cli }));
  }
  return out;
}

// Robô pegou o item (idempotente: só sai de 'aprovada').
export async function pegar(distribuicaoId, { s = db(), robo = 'pc' } = {}) {
  const { data: d } = await s.from('distribuicoes').select('id,status,progresso').eq('id', distribuicaoId).maybeSingle();
  if (!d) throw new Error('distribuição não encontrada');
  if (d.status !== 'aprovada') throw new Error(`item em "${d.status}", não está aprovado`);
  const { error } = await s.from('distribuicoes').update({ status: 'em_protocolo', progresso: { ...(d.progresso || {}), etapa: 'em_protocolo', robo, pegou_em: new Date().toISOString() } }).eq('id', d.id);
  if (error) throw new Error(error.message);
}

// Resultado do robô: sucesso grava número no processo (a Paula avisa a cliente pelo pos.js); erro volta para o advogado.
export async function registrarResultado(distribuicaoId, { ok, numero_processo, recibo_base64, recibo_nome, erro, tela_base64, detalhes } = {}, { s = db() } = {}) {
  const { data: d } = await s.from('distribuicoes').select('id,status,progresso,processo_id,cliente_id').eq('id', distribuicaoId).maybeSingle();
  if (!d) throw new Error('distribuição não encontrada');
  const base = `se-uploads/${d.cliente_id}/protocolo/${d.id.slice(0, 8)}`;
  const guardar = async (b64, nome, tipo) => { if (!b64) return null; const buf = Buffer.from(b64, 'base64'); const p = `${base}/${nome}`; const { error } = await s.storage.from(BUCKET).upload(p, buf, { contentType: tipo, upsert: true }); if (error) throw new Error(error.message); return p; };
  const agora = new Date().toISOString();
  const { data: cli } = await s.from('clientes').select('nome').eq('id', d.cliente_id).maybeSingle();
  if (ok) {
    const numero = String(numero_processo || '').trim();
    if (!numero) throw new Error('numero_processo obrigatório');
    const recibo = await guardar(recibo_base64, recibo_nome || 'recibo-protocolo.pdf', 'application/pdf');
    const resultado = { ok: true, numero_processo: numero, recibo_path: recibo, detalhes: detalhes || null, em: agora };
    const { error } = await s.from('distribuicoes').update({ status: 'protocolada', numero_processo: numero, resultado, progresso: { ...(d.progresso || {}), etapa: 'protocolada', protocolada_em: agora } }).eq('id', d.id);
    if (error) throw new Error(error.message);
    if (d.processo_id) await s.from('processos').update({ numero, status_processo: 'Em andamento', data_distribuicao: agora.slice(0, 10) }).eq('id', d.processo_id);
    await avisarOperador(`PROTOCOLADO — ${cli?.nome || d.cliente_id}\nNúmero: ${numero}${recibo ? '\nRecibo guardado no IURIA.' : ''}\nA Paula avisa a cliente e passa a acompanhar os andamentos.`);
    return resultado;
  }
  const tela = await guardar(tela_base64, `erro-${Date.now()}.png`, 'image/png');
  const resultado = { ok: false, erro: String(erro || 'erro não informado').slice(0, 2000), tela_path: tela, detalhes: detalhes || null, em: agora };
  const { error } = await s.from('distribuicoes').update({ status: 'erro', resultado, progresso: { ...(d.progresso || {}), etapa: 'erro', erro_em: agora } }).eq('id', d.id);
  if (error) throw new Error(error.message);
  await avisarOperador(`PROTOCOLO PAROU — ${cli?.nome || d.cliente_id}\n${resultado.erro}${tela ? '\nPrint da tela no painel.' : ''}\nO robô não tenta de novo sozinho: confira e aprove outra vez no painel.`);
  return resultado;
}
