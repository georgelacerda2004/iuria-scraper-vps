// Fluxo da conversa: recepção → consentimento → triagem por IA → handoff/encerrado.
import { responder } from './cerebro.js';
import { receberDocumento, concluirCadastro, verificarConclusao, guardarExtra, pagamentoDiferido, modoEntrada, MSG as CAP } from './captacao.js';
import { resumoProcesso } from './iuria.js';

const NOME_ROBO = process.env.NOME_ROBO || 'Paula';
const NOME_ESCRITORIO = process.env.NOME_ESCRITORIO || 'o escritório';

export const MSG = {
  boasVindas: (nome) =>
    `Oi${nome ? `, ${nome.split(' ')[0]}` : ''}! Aqui é a ${NOME_ROBO}, da ${NOME_ESCRITORIO}. Eu faço o primeiro atendimento sobre a Lei do Superendividamento (Lei 14.181/2021): entendo a sua situação e levo tudo para o advogado responsável.\n\n` +
    `Esse atendimento inicial é automático e as suas informações ficam guardadas de forma segura, só para a análise. Posso seguir? Responda *SIM* para continuar ou *SAIR* para encerrar.`,
  consentimentoOk:
    `Obrigado! Vamos lá. Me conta com suas palavras: quais dívidas você tem hoje (cartão, empréstimo, consignado, cheque especial...) e quanto sai por mês, mais ou menos?`,
  sair: `Tudo bem, encerrei por aqui e não guardei nada. Se quiser retomar, é só mandar uma mensagem.`,
  handoff: `Entendi. Vou passar a sua conversa para a equipe. Um advogado continua daqui em horário comercial.`,
  midia: `Recebi o arquivo, obrigado! Nesta primeira conversa não preciso de documentos ainda. Me responde por texto, por favor.`,
  erroIA: `Tive um problema aqui do meu lado. Pode repetir a última mensagem?`,
  // Mercado de indicação (consentimento específico, LGPD).
  pedirIndicacao: (nome) => `${nome ? nome.split(' ')[0] + ', u' : 'U'}ma pergunta importante. Além do nosso escritório, eu posso encaminhar o seu caso para um advogado parceiro cadastrado na nossa plataforma, para ele te chamar e dar andamento? Ele receberia o que você me contou aqui e o seu telefone, só para esse atendimento.\n\nResponda *SIM* para autorizar ou *NÃO* para deixar como está.`,
  indicacaoOk: `Combinado, obrigada! Vou encaminhar o seu caso. Assim que um advogado parceiro assumir, eu te aviso por aqui com o nome e a OAB dele.`,
  indicacaoNao: `Tudo bem, fica como está. Seguimos por aqui.`,
  emOferta: `Seu caso está sendo encaminhado para um advogado parceiro. Assim que ele assumir, eu te aviso por aqui com o nome e a OAB. Se preferir desistir disso, escreva *cancelar indicação*.`,
  indicado: `Seu caso já está com o advogado parceiro que eu te informei. Fale direto com ele. Se tiver algum problema para falar com ele, escreva *problema com o advogado* que a equipe verifica.`,
};

const RE_SIM = /^\s*(sim|s|ok|concordo|aceito|pode)\b/i;
const RE_SAIR = /^\s*(sair|parar|cancelar|não|nao)\b/i;
// Pedido explícito de humano. Só a palavra "advogado" não basta: a pessoa fala do advogado do vizinho,
// pergunta "o advogado vai ver?" etc. Exige verbo de pedido + alvo humano, ou "não quero falar com robô".
const RE_HUMANO = /((quero|queria|gostaria|posso|pode|preciso|prefiro|me (passa|passe|transfere|transfira)|chama|chame|cad[êe]|liga|ligar)[^.!?\n]{0,25}(advogad|atendente|humano|pessoa de verdade|pessoa real|algu[ée]m de verdade|com algu[ée]m))|(n[ãa]o quero falar com (rob[ôo]|m[áa]quina|bot))|(falar com (um|uma|o|a) (advogad|atendente|pessoa))/i;

// Recebe a conversa (linha do banco), o evento e o histórico; devolve { respostas: string[], patch: {} }.
export async function proximoPasso(conversa, ev, opts = {}) {
  const { historico = [], ia = responder } = opts;
  const etapa = conversa.etapa || 'novo';
  const texto = (ev.texto || '').trim();

  if (RE_HUMANO.test(texto)) return { respostas: [MSG.handoff], patch: { etapa: 'handoff', handoff_em: new Date().toISOString() } };
  if (etapa === 'handoff') return { respostas: [], patch: {} }; // humano assumiu; robô fica quieto
  if (etapa === 'encerrado') return { respostas: [MSG.boasVindas(ev.nome)], patch: { etapa: 'consentimento' } };

  // Mercado de indicação: consentimento expresso antes de oferecer o caso a um advogado parceiro.
  if (etapa === 'consentimento_indicacao') {
    if (RE_SIM.test(texto)) return { respostas: [MSG.indicacaoOk], patch: { consentimento_indicacao_em: new Date().toISOString(), etapa: 'em_oferta' }, oferecer: true };
    if (RE_SAIR.test(texto)) return { respostas: [MSG.indicacaoNao], patch: { etapa: conversa.etapa_anterior || 'triagem', etapa_anterior: null } };
    return { respostas: [MSG.pedirIndicacao(conversa.nome_perfil || ev.nome)], patch: {} };
  }
  if (etapa === 'em_oferta') {
    if (/cancelar/i.test(texto)) return { respostas: [MSG.indicacaoNao], patch: { etapa: conversa.etapa_anterior || 'triagem', consentimento_indicacao_em: null }, cancelarOferta: true };
    return { respostas: [MSG.emOferta], patch: {} };
  }
  if (etapa === 'indicado') {
    if (/problema/i.test(texto)) return { respostas: [MSG.handoff], patch: { etapa: 'handoff', handoff_em: new Date().toISOString(), handoff_motivo: 'cliente indicado relata problema com o advogado parceiro' } };
    return { respostas: [MSG.indicado], patch: {} };
  }

  if (etapa === 'novo') return { respostas: [MSG.boasVindas(ev.nome)], patch: { etapa: 'consentimento' } };

  if (etapa === 'consentimento') {
    if (RE_SIM.test(texto)) return { respostas: [MSG.consentimentoOk], patch: { etapa: 'triagem', consentimento_em: new Date().toISOString() } };
    if (RE_SAIR.test(texto)) return { respostas: [MSG.sair], patch: { etapa: 'encerrado' } };
    return { respostas: [MSG.boasVindas(ev.nome)], patch: {} };
  }

  // Pós-triagem (determinístico): documentos → cadastro → pagamento/assinatura → cliente.
  if (etapa === 'viavel') return { respostas: [CAP.inicioDocs(conversa.nome_perfil || ev.nome)], patch: { etapa: 'docs' } };
  if (etapa === 'docs') {
    let r;
    try { r = await receberDocumento(conversa, ev, opts.captacao); }
    catch (e) { console.error('[fluxo] documento falhou:', e.message); return { respostas: [MSG.erroIA], patch: {} }; }
    if (r.acao !== 'concluir') return r;
    try {
      const c = await concluirCadastro({ ...conversa, ...(r.patch || {}) }, opts.captacao);
      return { respostas: [...r.respostas, ...c.respostas], patch: { ...(r.patch || {}), ...c.patch } };
    } catch (e) {
      console.error('[fluxo] concluirCadastro falhou:', e.message);
      return { respostas: [...r.respostas, CAP.erro], patch: { ...(r.patch || {}), etapa: 'handoff', handoff_em: new Date().toISOString(), handoff_motivo: 'erro_cadastro:' + e.message } };
    }
  }
  if (etapa === 'pagamento_assinatura') {
    let r = null;
    try { r = await verificarConclusao(conversa, opts.captacao); } catch (e) { console.error('[fluxo] verificarConclusao:', e.message); }
    if (r && r.respostas.length) return r;
    const pend = { pago: !!(conversa.pago_em || r?.patch?.pago_em), diferido: pagamentoDiferido(conversa.triagem), modo: modoEntrada(conversa.triagem), assinados: 0, total: (conversa.triagem?.assinaturas || []).length };
    return { respostas: [CAP.aguardando(pend)], patch: r?.patch || {} };
  }
  if (etapa === 'cliente') {
    if (ev.mediaId) {
      try { return await guardarExtra(conversa, ev, opts.captacao); }
      catch (e) { console.error('[fluxo] guardarExtra:', e.message); return { respostas: ['Recebi o arquivo. Vou guardar na sua pasta e o advogado já tem acesso.'], patch: {} }; }
    }
    // Pós-contratação: a Paula responde com os dados do processo (número, status, últimos andamentos).
    let contexto = '';
    try { contexto = await (opts.resumoProcesso || resumoProcesso)(conversa.processo_id); } catch (e) { console.warn('[fluxo] resumoProcesso:', e.message); }
    let r;
    try { r = await ia({ historico, textoAtual: texto, fase: 'pos', contexto }); }
    catch (e) { console.error('[fluxo] IA (pos) falhou:', e.message); return { respostas: ['Seu caso está com o advogado. Ele responde por aqui em horário comercial. Se for urgente, escreva "falar com advogado".'], patch: {} }; }
    const patch = {};
    if (r.handoff) { patch.etapa = 'handoff'; patch.handoff_em = new Date().toISOString(); patch.handoff_motivo = r.handoff; }
    return { respostas: [r.texto], patch, usage: r.usage };
  }

  // triagem e proposta: IA conduz.
  if (ev.mediaId && !texto) return { respostas: [MSG.midia], patch: {} };
  const entrada = texto || `[enviou ${ev.tipo}]`;
  const fase = ['proposta', 'desistiu'].includes(etapa) ? 'proposta' : 'triagem';
  let r;
  try { r = await ia({ historico, textoAtual: entrada, fase }); }
  catch (e) { console.error('[fluxo] IA falhou:', e.message); return { respostas: [MSG.erroIA], patch: {} }; }

  const patch = {};
  if (r.calculo) patch.triagem = { ...(conversa.triagem || {}), calculo: r.calculo };
  const respostas = [r.texto];
  // Favorável → fase de proposta (a Paula explica o processo e as condições; só depois pede documentos).
  if (r.triagem) { patch.triagem = { ...(patch.triagem || conversa.triagem || {}), ...r.triagem }; patch.etapa = r.triagem.resultado === 'favoravel' ? 'proposta' : r.triagem.resultado === 'desfavoravel' ? 'inviavel' : 'triagem'; }
  if (r.proposta?.aceita) {
    patch.triagem = { ...(patch.triagem || conversa.triagem || {}), pagamento: r.proposta.pagamento, proposta_aceita_em: new Date().toISOString() };
    patch.etapa = 'docs';
    respostas.push(CAP.primeiroDoc); // o pedido do RG sai no mesmo turno
  } else if (r.proposta && !r.proposta.aceita) {
    patch.triagem = { ...(patch.triagem || conversa.triagem || {}), recusa_motivo: r.proposta.motivo };
    patch.etapa = 'desistiu';
  }
  if (r.handoff) { patch.etapa = 'handoff'; patch.handoff_em = new Date().toISOString(); patch.handoff_motivo = r.handoff; }
  return { respostas, patch, usage: r.usage };
}
