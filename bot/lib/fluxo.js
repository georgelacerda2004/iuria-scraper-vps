// Fluxo da conversa: recepção → consentimento → triagem por IA → handoff/encerrado.
import { responder } from './cerebro.js';

const NOME_ROBO = process.env.NOME_ROBO || 'assistente virtual do escritório';

export const MSG = {
  boasVindas: (nome) =>
    `Olá${nome ? `, ${nome.split(' ')[0]}` : ''}! Eu sou o ${NOME_ROBO}. Sou um robô, não um advogado, e estou aqui para tirar dúvidas sobre a Lei do Superendividamento (Lei 14.181/2021) e entender a sua situação antes de passar para a equipe.\n\n` +
    `Para continuar, preciso guardar as informações que você me enviar de forma segura, só para essa análise. Você concorda? Responda *SIM* para seguir ou *SAIR* para encerrar.`,
  consentimentoOk:
    `Obrigado! Vamos lá. Me conta com suas palavras: quais dívidas você tem hoje (cartão, empréstimo, consignado, cheque especial...) e quanto sai por mês, mais ou menos?`,
  sair: `Tudo bem, encerrei por aqui e não guardei nada. Se quiser retomar, é só mandar uma mensagem.`,
  handoff: `Entendi. Vou passar a sua conversa para a equipe do escritório. Um advogado continua daqui em horário comercial.`,
  midia: `Recebi o arquivo, obrigado! Nesta primeira conversa não preciso de documentos ainda. Me responde por texto, por favor.`,
  erroIA: `Tive um problema aqui do meu lado. Pode repetir a última mensagem?`,
};

const RE_SIM = /^\s*(sim|s|ok|concordo|aceito|pode)\b/i;
const RE_SAIR = /^\s*(sair|parar|cancelar|não|nao)\b/i;
const RE_HUMANO = /(advogad|atendente|humano|pessoa de verdade|falar com alguém|falar com alguem)/i;

// Recebe a conversa (linha do banco), o evento e o histórico; devolve { respostas: string[], patch: {} }.
export async function proximoPasso(conversa, ev, { historico = [], ia = responder } = {}) {
  const etapa = conversa.etapa || 'novo';
  const texto = (ev.texto || '').trim();

  if (RE_HUMANO.test(texto)) return { respostas: [MSG.handoff], patch: { etapa: 'handoff', handoff_em: new Date().toISOString() } };
  if (etapa === 'handoff') return { respostas: [], patch: {} }; // humano assumiu; robô fica quieto
  if (etapa === 'encerrado') return { respostas: [MSG.boasVindas(ev.nome)], patch: { etapa: 'consentimento' } };

  if (etapa === 'novo') return { respostas: [MSG.boasVindas(ev.nome)], patch: { etapa: 'consentimento' } };

  if (etapa === 'consentimento') {
    if (RE_SIM.test(texto)) return { respostas: [MSG.consentimentoOk], patch: { etapa: 'triagem', consentimento_em: new Date().toISOString() } };
    if (RE_SAIR.test(texto)) return { respostas: [MSG.sair], patch: { etapa: 'encerrado' } };
    return { respostas: [MSG.boasVindas(ev.nome)], patch: {} };
  }

  // triagem (e etapas seguintes enquanto a equipe não assume): IA conduz.
  if (ev.mediaId && !texto) return { respostas: [MSG.midia], patch: {} };
  const entrada = texto || `[enviou ${ev.tipo}]`;
  let r;
  try { r = await ia({ historico, textoAtual: entrada }); }
  catch (e) { console.error('[fluxo] IA falhou:', e.message); return { respostas: [MSG.erroIA], patch: {} }; }

  const patch = {};
  if (r.calculo) patch.triagem = { ...(conversa.triagem || {}), calculo: r.calculo };
  if (r.triagem) { patch.triagem = { ...(patch.triagem || conversa.triagem || {}), ...r.triagem }; patch.etapa = r.triagem.resultado === 'favoravel' ? 'viavel' : r.triagem.resultado === 'desfavoravel' ? 'inviavel' : 'triagem'; }
  if (r.handoff) { patch.etapa = 'handoff'; patch.handoff_em = new Date().toISOString(); patch.handoff_motivo = r.handoff; }
  return { respostas: [r.texto], patch, usage: r.usage };
}
