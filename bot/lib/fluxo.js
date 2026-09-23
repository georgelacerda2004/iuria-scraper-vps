// Fluxo da conversa. Nesta versão: recepção, identificação como assistente virtual,
// consentimento LGPD e handoff. A triagem por IA entra no próximo passo (lib/cerebro.js).
const NOME_ROBO = process.env.NOME_ROBO || 'assistente virtual do escritório';

export const MSG = {
  boasVindas: (nome) =>
    `Olá${nome ? `, ${nome.split(' ')[0]}` : ''}! Eu sou o ${NOME_ROBO}. Sou um robô, não um advogado, e estou aqui para tirar dúvidas sobre a Lei do Superendividamento (Lei 14.181/2021) e entender a sua situação antes de passar para a equipe.\n\n` +
    `Para continuar, preciso guardar as informações que você me enviar de forma segura, só para essa análise. Você concorda? Responda *SIM* para seguir ou *SAIR* para encerrar.`,
  consentimentoOk:
    `Obrigado! Vamos lá. Me conta com suas palavras: quais dívidas você tem hoje (cartão, empréstimo, consignado, cheque especial...) e quanto sai por mês, mais ou menos?`,
  sair: `Tudo bem, encerrei por aqui e não guardei nada. Se quiser retomar, é só mandar uma mensagem.`,
  handoff: `Entendi. Vou passar a sua conversa para a equipe do escritório. Um advogado continua daqui em horário comercial.`,
  aguardando: `Recebi! Estou preparando a análise da sua situação. Já te respondo.`,
};

const RE_SIM = /^\s*(sim|s|ok|concordo|aceito|pode)\b/i;
const RE_SAIR = /^\s*(sair|parar|cancelar|não|nao)\b/i;
const RE_HUMANO = /(advogad|atendente|humano|pessoa de verdade|falar com alguém|falar com alguem)/i;

// Recebe a conversa (linha do banco) e o evento; devolve { respostas: string[], patch: {} }.
export function proximoPasso(conversa, ev) {
  const etapa = conversa.etapa || 'novo';
  const texto = (ev.texto || '').trim();

  if (RE_HUMANO.test(texto)) return { respostas: [MSG.handoff], patch: { etapa: 'handoff', handoff_em: new Date().toISOString() } };
  if (etapa === 'handoff') return { respostas: [], patch: {} }; // humano assumiu; robô fica quieto

  if (etapa === 'novo') return { respostas: [MSG.boasVindas(ev.nome)], patch: { etapa: 'consentimento' } };

  if (etapa === 'consentimento') {
    if (RE_SIM.test(texto)) return { respostas: [MSG.consentimentoOk], patch: { etapa: 'triagem', consentimento_em: new Date().toISOString() } };
    if (RE_SAIR.test(texto)) return { respostas: [MSG.sair], patch: { etapa: 'encerrado' } };
    return { respostas: [MSG.boasVindas(ev.nome)], patch: {} };
  }

  // triagem: por enquanto só acusa recebimento; a IA entra no próximo passo.
  return { respostas: [MSG.aguardando], patch: {} };
}
