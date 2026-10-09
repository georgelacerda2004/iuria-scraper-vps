// SDR: retoma conversas que esfriaram. Dentro da janela de 24 h manda texto (fixo ou gerado pela IA);
// fora dela, só template aprovado. Zera quando a pessoa responde (db.upsertConversa).
import { db, gravarMensagem, atualizarConversa, carregarHistorico } from './db.js';
import { enviar } from './whatsapp.js';
import { responder } from './cerebro.js';
import { disponivel } from './templates.js';
import { modoEntrada } from './captacao.js';

const NOME_ROBO = () => process.env.NOME_ROBO || 'Paula';
const H = 3600_000;
// n = quantos follow-ups já foram. Espera (desde a última mensagem da pessoa) e canal.
export const AGENDA = [
  { depois: 1.5 * H, via: 'texto' },
  { depois: 8 * H, via: 'texto' },
  { depois: 26 * H, via: 'template' },
];
const ETAPAS = ['consentimento', 'triagem', 'proposta', 'docs', 'pagamento_assinatura'];

export function horaComercial(agora = new Date()) {
  const h = Number(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
  return h >= 8 && h < 21;
}

const primeiro = (n) => (n || '').split(' ')[0];
export function textoFixo(c) {
  const nome = primeiro(c.nome_perfil);
  const oi = `Oi${nome ? ', ' + nome : ''}! Aqui é a ${NOME_ROBO()} de novo.`;
  const t = c.triagem || {};
  if (c.etapa === 'consentimento') return `${oi} Vi que você clicou no anúncio sobre a Lei do Superendividamento. Posso te explicar rapidinho como funciona e ver se o seu caso se encaixa? Responda *SIM* que eu começo.`;
  if (c.etapa === 'docs') {
    const d = t.documentos || {};
    const falta = !d.pessoal ? 'a foto do RG ou CNH' : !d.endereco ? 'o comprovante de endereço' : 'o comprovante de renda';
    return `${oi} Ficou faltando ${falta} para eu finalizar o seu cadastro. Pode ser foto pelo celular mesmo. Se não estiver com o documento agora, escreva *pular* que a equipe pede depois.`;
  }
  if (c.etapa === 'pagamento_assinatura') {
    const links = (t.assinaturas || []).map((a, i) => `${i + 1}. ${a.nome}: ${a.link}`).join('\n');
    const pg = modoEntrada(t) === 'agora' && !c.pago_em && t.cobranca?.url ? `\nEntrada dos honorários: ${t.cobranca.url}` : '';
    return `${oi} Seu cadastro está quase pronto, só faltam as assinaturas (e o pagamento, se ainda não fez). Os links continuam valendo:\n${links}${pg}\n\nSe travou em alguma coisa, me conta que eu ajudo.`;
  }
  return `${oi} Nossa conversa ficou no meio. Quer continuar de onde paramos?`;
}

export function pendenciaCurta(c) {
  const t = c.triagem || {};
  if (c.etapa === 'consentimento') return 'responder SIM para começarmos';
  if (c.etapa === 'docs') { const d = t.documentos || {}; return !d.pessoal ? 'a foto do RG ou CNH' : !d.endereco ? 'o comprovante de endereço' : 'o comprovante de renda'; }
  if (c.etapa === 'pagamento_assinatura') return 'assinar os documentos';
  return 'continuar a conversa';
}

export async function montarTexto(c, deps = {}) {
  if (['triagem', 'proposta'].includes(c.etapa)) {
    const historico = await (deps.historico || carregarHistorico)(c.id);
    const r = await (deps.ia || responder)({ historico, textoAtual: '[a pessoa não respondeu; escreva a mensagem de retomada]', fase: 'retomada' });
    return r.texto;
  }
  return textoFixo(c);
}

// Um ciclo: devolve quantos follow-ups saíram.
export async function rodar({ agora = Date.now(), deps = {} } = {}) {
  const s = db();
  if (!s || !horaComercial(new Date(agora))) return 0;
  const { data } = await s.from('se_conversas').select('*').in('etapa', ETAPAS).lt('followup_n', AGENDA.length).not('ultima_entrada_em', 'is', null).order('ultima_entrada_em', { ascending: true }).limit(40);
  let enviados = 0;
  for (const c of data || []) {
    const passo = AGENDA[c.followup_n];
    if (!passo) continue;
    // Espera contada desde a última mensagem da pessoa E, a partir do segundo, um intervalo mínimo desde o follow-up anterior
    // (senão, quem ficou a noite toda em silêncio recebe dois seguidos às 8h).
    const desdeEntrada = agora - new Date(c.ultima_entrada_em).getTime();
    const desdeUltimo = c.followup_em ? agora - new Date(c.followup_em).getTime() : Infinity;
    const intervalo = c.followup_n ? passo.depois - AGENDA[c.followup_n - 1].depois : 0;
    if (desdeEntrada < passo.depois || desdeUltimo < intervalo) continue;
    try {
      const texto = passo.via === 'texto' ? await montarTexto(c, deps) : null;
      const r = await (deps.enviar || enviar)({ to: c.wa_id, texto, ultimaEntradaEm: c.ultima_entrada_em, template: c.etapa === 'consentimento' || c.etapa === 'triagem' || c.etapa === 'proposta' ? 'se_retomada' : 'se_pendencia', params: c.etapa === 'consentimento' || c.etapa === 'triagem' || c.etapa === 'proposta' ? [primeiro(c.nome_perfil) || 'tudo bem'] : [primeiro(c.nome_perfil) || 'tudo bem', pendenciaCurta(c)], templateDisponivel: deps.templateDisponivel || disponivel });
      if (!r) { await atualizarConversa(c.id, { followup_n: AGENDA.length }); continue; } // sem template aprovado: para de tentar
      await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: r.via === 'template' ? 'template' : 'text', texto: r.texto, waMessageId: r.out?.messages?.[0]?.id });
      await atualizarConversa(c.id, { followup_n: c.followup_n + 1, followup_em: new Date(agora).toISOString() });
      enviados++;
    } catch (e) { console.error('[followup]', c.wa_id, e.message); }
  }
  return enviados;
}
