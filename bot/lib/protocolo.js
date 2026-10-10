// Fila de protocolo: distribuição rascunho -> pronta (pacote de PDFs) -> aprovada (toque do advogado no painel)
// -> em_protocolo (robô do PC pegou) -> protocolada | erro. O robô nunca protocola sem a aprovação.
import { db } from './db.js';
import { montarPacote } from './pacote.js';
import { avisarOperador } from './iuria.js';
import { partirEndereco } from './peticao.js';
import { jurisdicaoPara } from './foro.js';

const BUCKET = 'documentos';
export const STATUS = ['rascunho', 'pronta', 'aprovada', 'em_protocolo', 'protocolada', 'erro'];
// Sobe quando o layout do PDF muda: pacotes 'pronta' de versão antiga são refeitos (aprovados/protocolados não).
export const PACOTE_VERSAO = 2;

// Distribuições em rascunho cuja petição já existe: gera o pacote e marca 'pronta'. Roda periodicamente.
export async function prepararPacotes({ s = db(), limite = 5 } = {}) {
  if (!s) return [];
  const { data: lista } = await s.from('distribuicoes').select('*').in('status', ['rascunho', 'pronta']).not('entrevista_id', 'is', null).order('created_at', { ascending: true }).limit(50);
  const dists = (lista || []).filter(d => d.status === 'rascunho' || Number(d.progresso?.pacote_versao || 1) < PACOTE_VERSAO).slice(0, limite);
  const feitas = [];
  for (const d of dists || []) {
    try {
      const { data: e } = await s.from('inicial_entrevistas').select('peticao_html,status').eq('id', d.entrevista_id).maybeSingle();
      if (!e?.peticao_html) continue;
      const { pacote, avisos } = await montarPacote({ distribuicao: d, clienteId: d.cliente_id, peticaoHtml: e.peticao_html });
      const refeito = d.status === 'pronta';
      // PROTOCOLO_AUTO=on: a Paula manda protocolar assim que o pacote fica pronto (sem o toque no painel).
      const auto = process.env.PROTOCOLO_AUTO === 'on' && d.status === 'rascunho';
      const progresso = { ...(d.progresso || {}), etapa: auto ? 'aprovada' : 'pacote_pronto', pacote, avisos, pacote_em: new Date().toISOString(), pacote_versao: PACOTE_VERSAO, ...(auto ? { aprovado_por: 'automático (PROTOCOLO_AUTO)', aprovado_em: new Date().toISOString() } : {}) };
      const { error } = await s.from('distribuicoes').update({ status: auto ? 'aprovada' : 'pronta', progresso }).eq('id', d.id);
      if (error) throw new Error(error.message);
      if (refeito) { feitas.push(d.id); continue; } // só atualizou os PDFs: não avisa de novo
      const { data: cli } = await s.from('clientes').select('nome').eq('id', d.cliente_id).maybeSingle();
      await avisarOperador(`PRONTO PARA PROTOCOLAR — ${cli?.nome || d.cliente_id}\n${pacote.length} PDF(s) montados (petição + anexos). Valor da causa R$ ${Number(d.valor_causa || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.${avisos.length ? '\nAvisos: ' + avisos.join('; ') : ''}\n${process.env.PROTOCOLO_AUTO === 'on' ? 'Já está na fila do robô do escritório: ele protocola na próxima rodada.' : 'Para protocolar: abrir o painel, conferir e tocar em "Aprovar e protocolar". O robô do escritório faz o resto.'}`);
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
// Sexo para o cadastro de PF no eproc: usa o dado do cliente; senão deduz pelo primeiro nome e marca como inferido.
export function sexoDe(cliente) {
  if (cliente?.sexo) return { sexo: String(cliente.sexo)[0].toUpperCase(), inferido: false };
  const n = String(cliente?.nome || '').trim().split(/\s+/)[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!n) return { sexo: 'F', inferido: true };
  const FEM = new Set(['ester', 'esther', 'raquel', 'isabel', 'ines', 'beatriz', 'lais', 'iris', 'lourdes', 'conceicao', 'suely', 'sueli', 'eliene', 'jane', 'adriane', 'thais', 'liz', 'cris', 'nair', 'edith', 'ruth', 'elisabeth', 'elizabeth', 'margareth', 'gisele', 'michele', 'simone', 'ivone', 'ivonete', 'marlene', 'darlene', 'irene', 'helene', 'solange', 'jaqueline', 'jacqueline', 'caroline', 'aline', 'pauline', 'eunice', 'alice', 'clarice', 'berenice', 'doris', 'taty', 'juh', 'gabi', 'vivi', 'mel', 'nicole', 'dayse', 'dalvane']);
  const MASC = new Set(['luca', 'nicola', 'josue', 'joshua', 'elia', 'isaia', 'jeremia', 'andrea']);
  const fem = (FEM.has(n) || (/a$/.test(n) && !MASC.has(n)) || /(ene|ine|ice|ete|ith|eth)$/.test(n)) && !MASC.has(n);
  return { sexo: fem ? 'F' : 'M', inferido: true };
}

// Polo ativo completo para o eproc: endereço partido (logradouro, número, bairro), sexo e foro regional pelo CEP.
export async function completarAtivo(ativo = [], cliente = null, deps = {}) {
  return Promise.all(ativo.map(async a => {
    const end = (!a.logradouro || !a.numero) ? partirEndereco(cliente?.endereco || a.logradouro || '') : null;
    const sx = sexoDe({ ...cliente, nome: a.nome || cliente?.nome });
    return {
      ...a,
      logradouro: a.logradouro && a.numero ? a.logradouro : (end?.logradouro || a.logradouro || ''),
      numero: a.numero || end?.numero || '', complemento: a.complemento || end?.complemento || '',
      bairro: a.bairro || cliente?.bairro || end?.bairro || '', cidade: a.cidade || cliente?.cidade || '', uf: a.uf || cliente?.uf || '', cep: a.cep || cliente?.cep || '',
      sexo: sx.sexo, sexo_inferido: sx.inferido,
    };
  }));
}

export async function montarItemFila(d, { s = db(), cliente = null, assinarUrl, foro } = {}) {
  const assinar = assinarUrl || (async p => { const { data, error } = await s.storage.from(BUCKET).createSignedUrl(p, 3600); if (error) throw new Error(error.message); return data.signedUrl; });
  const arquivos = [];
  for (const p of d.progresso?.pacote || []) arquivos.push({ ...p, url: await assinar(p.storage_path) });
  const ativo = await completarAtivo(d.partes?.ativo || [], cliente);
  const a0 = ativo[0] || {};
  const jurisdicao = await jurisdicaoPara({ cidade: a0.cidade || cliente?.cidade, uf: a0.uf || cliente?.uf, cep: a0.cep || cliente?.cep }, { foroPorCep: foro }).catch(() => null) || d.jurisdicao;
  return {
    distribuicao_id: d.id, status: d.status, tribunal: d.tribunal, sistema: d.sistema, grau: d.grau,
    classe: d.classe_nome, classe_codigo: d.classe_codigo, assuntos: d.assuntos, competencia: d.competencia, area: d.area_direito,
    jurisdicao, comarca: d.comarca, valor_causa: d.valor_causa, justica_gratuita: d.justica_gratuita, tutela_liminar: d.tutela_liminar,
    prioridade: d.prioridade, segredo_justica: d.segredo_justica, opcoes: { juizo_digital: true, ...(d.opcoes_adicionais || {}) }, partes: { ...(d.partes || {}), ativo },
    cliente: cliente ? { nome: cliente.nome, cpf: cliente.cpf, cidade: cliente.cidade, uf: cliente.uf } : null,
    arquivos, aprovado_em: d.progresso?.aprovado_em || null, aprovado_por: d.progresso?.aprovado_por || null,
  };
}

export async function fila({ s = db(), status = ['aprovada', 'em_protocolo'] } = {}) {
  const { data: dists } = await s.from('distribuicoes').select('*').in('status', status).order('updated_at', { ascending: true }).limit(20);
  const out = [];
  for (const d of dists || []) {
    const { data: cli } = await s.from('clientes').select('nome,cpf,cidade,uf,cep,endereco,bairro').eq('id', d.cliente_id).maybeSingle();
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
export async function registrarResultado(distribuicaoId, corpo = {}, { s = db() } = {}) {
  // Aceita os nomes do contrato (recibo_base64/tela_base64) e os do motor do Hermes (recibo_pdf_base64/print_base64).
  const { ok, numero_processo, recibo_nome, erro, detalhes } = corpo;
  const recibo_base64 = corpo.recibo_base64 || corpo.recibo_pdf_base64 || null;
  const tela_base64 = corpo.tela_base64 || corpo.print_base64 || corpo.screenshot_base64 || null;
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
    const chave = String(detalhes?.chave || detalhes?.chave_consulta || '').trim() || null;
    const juizo = String(detalhes?.juizo || detalhes?.vara || '').trim() || null;
    const resultado = { ok: true, numero_processo: numero, chave, juizo, sistema: detalhes?.sistema || d.sistema || 'eproc', recibo_path: recibo, detalhes: detalhes || null, em: agora };
    const { error } = await s.from('distribuicoes').update({ status: 'protocolada', numero_processo: numero, resultado, progresso: { ...(d.progresso || {}), etapa: 'protocolada', protocolada_em: agora } }).eq('id', d.id);
    if (error) throw new Error(error.message);
    if (d.processo_id) {
      const patchP = { numero, status_processo: 'Em andamento', data_distribuicao: agora.slice(0, 10), sistema: (detalhes?.sistema || d.sistema || 'eproc').toLowerCase() };
      if (juizo) { const m = juizo.match(/^(.*?)(?:\s*[-–]\s*(.*))?$/); patchP.vara = (m?.[1] || juizo).trim(); if (m?.[2]) patchP.comarca = m[2].trim(); }
      await s.from('processos').update(patchP).eq('id', d.processo_id);
    }
    await avisarOperador(`PROTOCOLADO — ${cli?.nome || d.cliente_id}\nNúmero: ${numero}${chave ? ' · chave ' + chave : ''}${juizo ? '\n' + juizo : ''}${recibo ? '\nRecibo guardado no IURIA.' : ''}\nA Paula avisa a cliente e passa a acompanhar os andamentos.`);
    return resultado;
  }
  const tela = await guardar(tela_base64, `erro-${Date.now()}.png`, 'image/png');
  const resultado = { ok: false, erro: String(erro || 'erro não informado').slice(0, 2000), tela_path: tela, detalhes: detalhes || null, em: agora };
  const { error } = await s.from('distribuicoes').update({ status: 'erro', resultado, progresso: { ...(d.progresso || {}), etapa: 'erro', erro_em: agora } }).eq('id', d.id);
  if (error) throw new Error(error.message);
  await avisarOperador(`PROTOCOLO PAROU — ${cli?.nome || d.cliente_id}\n${resultado.erro}${tela ? '\nPrint da tela no painel.' : ''}\nO robô não tenta de novo sozinho: confira e aprove outra vez no painel.`);
  return resultado;
}
