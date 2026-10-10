// Leitura dos andamentos para a cliente: a Paula classifica cada movimentação (decisão, despacho, liminar
// deferida/indeferida, audiência, citação, sentença...) e explica em linguagem simples. Com liminar deferida,
// dispara o que o contrato prevê: entrada "após a liminar" (cobrança Asaas) e registro do êxito no IURIA.
import Anthropic from '@anthropic-ai/sdk';
import { db, atualizarConversa } from './db.js';
import { garantirCliente, criarCobranca } from './asaas.js';
import { avisarOperador } from './iuria.js';
import { projetarPlano } from './plano.js';

const MODELO = () => process.env.CLAUDE_MODEL_ANDAMENTOS || process.env.CLAUDE_MODEL || 'claude-opus-5-5';
let _api = null;
const api = () => (_api ||= new Anthropic());

export const CATEGORIAS = ['liminar_deferida', 'liminar_indeferida', 'decisao', 'despacho', 'citacao', 'audiencia', 'sentenca', 'acordo', 'juntada', 'outro'];

const SYSTEM = `Você é assistente de um escritório de advocacia brasileiro e explica movimentações processuais para clientes leigos, em ações de repactuação de dívidas (Lei 14.181/2021, superendividamento). Responda SOMENTE um JSON:
{"categoria": "<uma de: ${CATEGORIAS.join(', ')}>", "resumo_cliente": "<2 a 4 frases simples, em português do Brasil, sem juridiquês, dizendo o que aconteceu e o que muda na prática para a pessoa; nunca prometa resultado>", "precisa_acao_cliente": "<o que a pessoa precisa fazer, ou vazio>", "data_evento": "<AAAA-MM-DD se o texto citar uma data de audiência/prazo, senão vazio>"}
Regras: "liminar_deferida" só quando a decisão CONCEDE a tutela de urgência/liminar (limita descontos, suspende cobrança etc.). "liminar_indeferida" quando NEGA. Juntadas de documentos, certidões e atos de secretaria são "juntada" ou "outro". Audiência designada é "audiencia". Citação/intimação expedida é "citacao".`;

// Heurística de apoio (sem IA) para os casos óbvios e para testes.
export function classificarRapido(a) {
  const t = `${a.tipo || ''} ${a.descricao || ''}`.toLowerCase();
  const negada = /indef[ei]r[a-z]*\s+(a\s+|o\s+)?(pedido\s+de\s+)?(tutela|liminar)|tutela[^.]{0,40}indeferid|liminar[^.]{0,40}indeferid|nega[a-z]*\s+(a\s+)?(tutela|liminar)|n[ãa]o\s+conced/.test(t);
  if (negada) return 'liminar_indeferida';
  if (/(?<!in)(def[ei]r|conced)[a-z]*\s+(a\s+|o\s+)?(pedido\s+de\s+)?(tutela|liminar)|tutela[^.]{0,40}(?<!in)deferid|liminar[^.]{0,40}(?<!in)deferid/.test(t)) return 'liminar_deferida';
  if (/audi[êe]ncia/.test(t)) return 'audiencia';
  if (/senten[çc]a/.test(t)) return 'sentenca';
  if (/cita[çc][ãa]o|intima[çc][ãa]o expedida|mandado/.test(t)) return 'citacao';
  if (/acordo|homolog/.test(t)) return 'acordo';
  if (/juntad|certid[ãa]o|petição juntada|documento/.test(t)) return 'juntada';
  if (/decis[ãa]o/.test(t)) return 'decisao';
  if (/despacho|conclus/.test(t)) return 'despacho';
  return 'outro';
}

export async function classificarAndamento(a, { contexto = '', deps = {} } = {}) {
  const rapido = classificarRapido(a);
  if (deps.classificar) return deps.classificar(a);
  if (!process.env.ANTHROPIC_API_KEY) return { categoria: rapido, resumo_cliente: '', precisa_acao_cliente: '', data_evento: '' };
  try {
    const r = await api().messages.create({
      model: MODELO(), max_tokens: 600,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Contexto do caso: ${contexto || 'ação de repactuação de dívidas'}\n\nMovimentação (${a.data || 'sem data'}): ${a.tipo || ''}\n${a.descricao || ''}${a.observacao ? '\n' + a.observacao : ''}` }],
    });
    const texto = r.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const j = JSON.parse((texto.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    return { categoria: CATEGORIAS.includes(j.categoria) ? j.categoria : rapido, resumo_cliente: String(j.resumo_cliente || ''), precisa_acao_cliente: String(j.precisa_acao_cliente || ''), data_evento: String(j.data_evento || '') };
  } catch (e) {
    console.warn('[andamentos] IA falhou, usando heurística:', e.message);
    return { categoria: rapido, resumo_cliente: '', precisa_acao_cliente: '', data_evento: '' };
  }
}

const ROTULO = { liminar_deferida: 'Liminar concedida', liminar_indeferida: 'Liminar negada por enquanto', decisao: 'Decisão do juiz', despacho: 'Despacho do juiz', citacao: 'Citação dos bancos', audiencia: 'Audiência marcada', sentenca: 'Sentença', acordo: 'Acordo', juntada: 'Documento juntado', outro: 'Movimentação' };

// Texto da Paula para a cliente, com a explicação.
export function textoAndamentoExplicado({ nome, processo, andamento, classe, link }) {
  const primeiro = (nome || '').split(' ')[0];
  const cab = `${primeiro ? primeiro + ', n' : 'N'}ovidade no seu processo ${processo.numero}: *${ROTULO[classe.categoria] || 'Movimentação'}*`;
  const quando = andamento.data ? ` (${andamento.data})` : '';
  const original = (andamento.descricao || andamento.tipo || '').slice(0, 300);
  const explic = classe.resumo_cliente ? `\n\n${classe.resumo_cliente}` : '';
  const acao = classe.precisa_acao_cliente ? `\n\n*O que você precisa fazer:* ${classe.precisa_acao_cliente}` : '';
  const extra = classe.categoria === 'liminar_deferida' ? '\n\n🎉 Essa é a decisão que a gente estava esperando. O advogado vai conferir os termos e eu te explico os próximos passos.' : classe.categoria === 'liminar_indeferida' ? '\n\nIsso não encerra nada: o processo segue para a audiência com os bancos, e o advogado avalia se cabe recurso.' : '';
  return `${cab}${quando}\n\n_"${original}"_${explic}${acao}${extra}\n\nAcompanhe aqui: ${link}\n\nQualquer dúvida, me pergunta. Aqui é a ${process.env.NOME_ROBO || 'Paula'}.`;
}

// Liminar deferida: cobra a entrada "após a liminar" (10 dias, como no contrato), registra o êxito projetado no
// IURIA e avisa o operador. Idempotente: marca triagem.liminar_deferida_em.
export async function tratarLiminarDeferida({ conversa, cliente, processo, andamento, deps = {} }) {
  const s = db();
  const triagem = conversa.triagem || {};
  if (triagem.liminar_deferida_em) return { ja: true };
  const agora = new Date().toISOString();
  const patch = { liminar_deferida_em: agora, liminar_andamento_id: andamento?.id || null };
  const avisos = [];
  const producao = /api\.asaas\.com/.test(process.env.ASAAS_BASE_URL || '');
  // 1) Entrada após a liminar
  if ((triagem.pagamento === 'apos_liminar') && !triagem.cobranca?.url) {
    const valor = Number(process.env.HONORARIOS_ENTRADA || 500);
    if (producao || deps.criarCobranca) {
      try {
        const customerId = await (deps.garantirCliente || garantirCliente)({ nome: cliente.nome, cpf: cliente.cpf, celular: conversa.wa_id, email: cliente.email });
        const cob = await (deps.criarCobranca || criarCobranca)({ customerId, valor, referencia: `se-entrada-${conversa.id}`, descricao: `Honorários: entrada após a liminar (processo ${processo.numero})` });
        patch.cobranca = { ...cob, valor, criada_em: agora, motivo: 'liminar_deferida' };
        if (s) await s.from('honorarios').update({ forma_pagamento: 'Asaas (após liminar)', observacao: `Entrada cobrada após a liminar deferida em ${agora.slice(0, 10)}. Cobrança ${cob.id}.` }).eq('processo_id', processo.id).eq('tipo', 'Contratual').eq('status', 'A receber');
      } catch (e) { avisos.push('cobrança da entrada não gerada: ' + e.message); }
    } else avisos.push('Asaas em sandbox: cobrança da entrada NÃO gerada (configure ASAAS_BASE_URL de produção).');
  }
  // 2) Êxito projetado no IURIA
  const plano = projetarPlano(triagem);
  const h = plano?.honorarios;
  if (s && h?.total > 0) {
    const { error } = await s.from('honorarios').insert({ cliente_id: cliente.id, processo_id: processo.id, tipo: 'Êxito', valor_total: h.total, num_parcelas: h.parcelas || 12, data_acordo: agora.slice(0, 10), forma_pagamento: 'Mensal (após a decisão)', status: 'A receber', observacao: `Êxito projetado: ${h.pct}% da economia mensal estimada (R$ ${h.economia_mensal}) x ${h.meses} meses = R$ ${h.total}, em ${h.parcelas} parcelas de R$ ${h.parcela} (teto ${h.teto_pct}% do alívio). Conferir com os termos da liminar.`, criado_por: cliente.criado_por });
    if (error) avisos.push('êxito não registrado: ' + error.message); else patch.exito_registrado = h;
  }
  await atualizarConversa(conversa.id, { triagem: { ...triagem, ...patch } });
  await avisarOperador(`LIMINAR DEFERIDA — ${cliente.nome} (${processo.numero})\n${(andamento?.descricao || '').slice(0, 300)}\n${patch.cobranca?.url ? 'Entrada de R$ ' + patch.cobranca.valor + ' cobrada: ' + patch.cobranca.url : 'Entrada: ' + (triagem.pagamento === 'ad_exitum' ? 'não há (ad exitum)' : triagem.cobranca?.url ? 'já cobrada antes' : 'pendente')}\n${h?.total ? 'Êxito projetado registrado no IURIA: R$ ' + h.total + ' em ' + h.parcelas + 'x' : ''}${avisos.length ? '\nAvisos: ' + avisos.join('; ') : ''}`);
  return { patch, avisos };
}

// Mensagem complementar da Paula quando a liminar sai e há entrada a pagar.
export function textoEntradaAposLiminar({ nome, cobranca }) {
  const primeiro = (nome || '').split(' ')[0];
  return `${primeiro ? primeiro + ', c' : 'C'}omo combinamos no contrato, a entrada de R$ ${Number(cobranca.valor).toFixed(2).replace('.', ',')} vence em até 10 dias depois da liminar. Pode pagar por Pix, boleto ou cartão neste link: ${cobranca.url}\n\nSe precisar de mais prazo, me fala que eu aviso o advogado.`;
}
