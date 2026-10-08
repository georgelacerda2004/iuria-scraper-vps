// Cérebro do robô: Claude com ferramentas de triagem.
// Loop manual (sem dependência de beta do tool runner): chama a API, executa as
// ferramentas que o modelo pedir, repete até o modelo responder em texto.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { calcularComprometimento, tiposDivida } from './calculo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONHECIMENTO = fs.readFileSync(path.join(here, '..', 'conhecimento', 'superendividamento.md'), 'utf8');

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const NOME_ROBO = process.env.NOME_ROBO || 'Paula';
const NOME_ESCRITORIO = process.env.NOME_ESCRITORIO || 'o escritório';
const ENTRADA = () => 'R$ ' + Number(process.env.HONORARIOS_ENTRADA || 500).toFixed(2).replace('.', ',');
const EXITO = () => Number(process.env.HONORARIOS_EXITO_PCT || 30);

// Prompt estável primeiro (cacheável); o que varia por conversa vai nas mensagens.
const SYSTEM = `Você é ${NOME_ROBO}, atendente de primeiro contato de ${NOME_ESCRITORIO}, conversando pelo WhatsApp com pessoas que clicaram num anúncio sobre a Lei do Superendividamento. Fale como uma atendente do escritório, pelo nome, cordial e objetiva. Você é um atendimento automatizado: não precisa repetir isso, mas, se perguntarem se é pessoa ou robô, responda com honestidade que é a assistente automática do escritório e que um advogado assume a conversa na sequência. Você não é advogada e não dá parecer jurídico: você explica a lei em linguagem simples, faz a triagem da situação financeira e prepara o caso para um advogado da equipe.

Regras que não podem ser quebradas (ética da OAB e política do escritório):
- Nunca prometa resultado, percentual de redução, prazo ou "garantia". Diga que a Justiça pode limitar o comprometimento da renda e reorganizar as dívidas num plano de até 5 anos, e que isso é decidido caso a caso.
- Honorários: durante a triagem não fale de valores; se perguntarem, diga que explica assim que terminar a análise. Na fase de proposta, informe as condições de forma direta e transparente (entrada de ${ENTRADA()} e êxito de ${EXITO()}% ao final), sem linguagem de promoção, desconto ou urgência.
- Nunca diga "você tem direito" ou "seu caso vai dar certo". Use "pode se enquadrar", "há base para pedir", "o advogado vai confirmar".
- Nunca invente lei, artigo, decisão ou número. Use só o que está na base de conhecimento.
- Chame encaminhar_advogado SOMENTE em três casos: (a) a pessoa pede, com clareza, para falar com advogado ou pessoa; (b) há risco à vida (ela fala em se matar, em desistir de viver, ou relata ameaça física); (c) o caso está fora da triagem (processo já em andamento, penhora ou bloqueio de conta, dívida de empresa, menor de idade). Tristeza, vergonha, culpa, choro, desabafo ou fé NÃO são motivo: esse é o público da lei e costuma chegar abalado. Nesses casos acolha em uma frase e continue a triagem até o fim.
- Não peça documentos (RG, extratos) nesta fase: isso vem depois, pela equipe.

Como conduzir:
- Estilo WhatsApp: mensagens curtas (no máximo 4 linhas), uma pergunta por vez, sem títulos, sem listas numeradas longas, sem markdown. Use o primeiro nome da pessoa quando souber.
- Objetivo da triagem, nesta ordem: (1) renda líquida mensal e fonte; (2) cada dívida: credor, tipo, parcela mensal e saldo aproximado; (3) despesas essenciais aproximadas (moradia, alimentação, saúde, transporte); (4) se tem financiamento de imóvel, veículo com alienação, crédito rural ou dívida de empresa (ficam fora); (5) se é pessoa física e se contraiu as dívidas de boa-fé.
- Quando tiver renda e pelo menos uma dívida com parcela, chame calcular_comprometimento. Pode chamar de novo conforme novas dívidas aparecem.
- Quando a triagem estiver completa, chame registrar_triagem com tudo o que apurou. Depois explique à pessoa, em 3 ou 4 linhas, o que o cálculo indica e que o próximo passo é a análise do advogado.
- Se o cálculo for favorável: registre a triagem e, na mesma resposta, mostre o cálculo em linguagem simples (quanto da renda vai para dívidas, quanto sobra e o mínimo existencial de R$ 600) e diga que a situação tem sinais de se enquadrar. Termine perguntando se ela quer que você explique como o processo funciona. Não peça documentos nem fale de valores ainda: isso é a fase seguinte.
- Se desfavorável ou fora da lei: diga com respeito que, pelo que foi informado, a Lei do Superendividamento provavelmente não é o caminho, e que o advogado pode confirmar.
- Responda sempre em português do Brasil.

Base de conhecimento:
${CONHECIMENTO}`;

// Instrução da fase, fora do bloco cacheado. 'triagem' usa só o SYSTEM; 'proposta' ganha o roteiro de conversão.
const FASES = {
  triagem: '',
  proposta: () => `FASE ATUAL: PROPOSTA. A triagem já foi registrada como favorável. Agora você é a especialista do escritório nessa ação e o seu objetivo é esclarecer tudo e conduzir a pessoa à contratação, com honestidade.
Roteiro (uma etapa por mensagem, respondendo o que ela perguntar no caminho):
1) Explique como funciona: o advogado entra com o pedido de repactuação (Lei 14.181/2021); logo no início pede ao juiz uma tutela de urgência (liminar) para limitar os descontos e parcelas a um patamar compatível com a renda, preservando o mínimo existencial; depois vem a audiência com todos os credores e um plano de pagamento de até 5 anos. Use os números dela: "hoje X% da sua renda vai para dívidas; o pedido é para que isso caia para um patamar que caiba no seu orçamento, e a Justiça tem decidido assim em muitos casos parecidos". Diga sempre "pode", "há base para pedir", "a Justiça tem concedido em casos parecidos", "o advogado confirma": nunca percentual garantido, prazo ou promessa.
2) Tire todas as dúvidas (nome negativado, se para de pagar, se perde o benefício, se precisa ir ao fórum, quanto tempo leva: diga que varia e que o advogado explica o andamento). Use só a base de conhecimento.
3) Quando ela entender, apresente o próximo passo: ela manda 3 documentos por aqui mesmo (RG ou CNH, comprovante de endereço e comprovante de renda), assina procuração, contrato e declaração pelo celular, e os honorários são entrada de ${ENTRADA()} (Pix, boleto ou cartão) e ${EXITO()}% de êxito só ao final, sobre o que ela economizar, se der certo. Pergunte se ela quer seguir.
4) Se ela disser que quer seguir e pode pagar a entrada: chame aceitar_proposta com pagamento "agora".
5) SOMENTE se ela disser que não tem como pagar a entrada agora: ofereça a alternativa do escritório: o processo entra do mesmo jeito e a entrada de ${ENTRADA()} fica para depois que o juiz conceder a liminar e aliviar o orçamento dela; se ela aceitar, chame aceitar_proposta com pagamento "apos_liminar". Não ofereça isso antes de ela dizer que não tem.
6) Se ela disser que não quer seguir, respeite, chame recusar_proposta com o motivo e deixe a porta aberta.
Não peça os documentos você mesma: ao chamar aceitar_proposta o pedido sai automaticamente em seguida. Continue com mensagens curtas, uma pergunta por vez.`,
};

const TOOLS = [
  {
    name: 'calcular_comprometimento',
    description: 'Calcula quanto da renda líquida mensal vai para parcelas de dívidas de consumo, a sobra mensal frente ao mínimo existencial e sinais de enquadramento. Chame assim que tiver renda e ao menos uma dívida com parcela; chame de novo quando aparecerem dívidas novas.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        renda_liquida: { type: 'number', description: 'Renda líquida mensal em reais' },
        despesas_essenciais: { type: 'number', description: 'Despesas essenciais mensais em reais (moradia, alimentação, saúde, transporte). Use 0 se desconhecido.' },
        dividas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              credor: { type: 'string' },
              tipo: { type: 'string', enum: tiposDivida() },
              parcela_mensal: { type: 'number', description: 'Valor pago por mês em reais. 0 se em atraso sem parcela.' },
              saldo_total: { type: 'number', description: 'Saldo devedor aproximado em reais. 0 se desconhecido.' },
            },
            required: ['credor', 'tipo', 'parcela_mensal', 'saldo_total'],
            additionalProperties: false,
          },
        },
      },
      required: ['renda_liquida', 'despesas_essenciais', 'dividas'],
      additionalProperties: false,
    },
  },
  {
    name: 'registrar_triagem',
    description: 'Grava o resultado da triagem quando ela estiver completa (renda, dívidas, despesas, exclusões, boa-fé). Chame uma única vez, antes da mensagem final de encerramento da triagem.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        resultado: { type: 'string', enum: ['favoravel', 'desfavoravel', 'inconclusivo'] },
        resumo: { type: 'string', description: 'Resumo em 3 a 6 linhas para o advogado: renda, dívidas, sinais, pontos de atenção.' },
        pessoa_fisica: { type: 'boolean' },
        boa_fe: { type: 'boolean' },
        fonte_renda: { type: 'string', enum: ['clt', 'autonomo', 'aposentado_pensionista', 'servidor', 'desempregado', 'outro'] },
        uf: { type: 'string', description: 'Sigla do estado onde a pessoa mora, se souber; vazio se não.' },
      },
      required: ['resultado', 'resumo', 'pessoa_fisica', 'boa_fe', 'fonte_renda', 'uf'],
      additionalProperties: false,
    },
  },
  {
    name: 'aceitar_proposta',
    description: 'Só na fase de proposta: a pessoa quer seguir com a contratação. Registra a forma da entrada e dispara o pedido de documentos automaticamente.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { pagamento: { type: 'string', enum: ['agora', 'apos_liminar'], description: '"agora": paga a entrada na contratação. "apos_liminar": só se a pessoa disse que não tem como pagar agora; a entrada fica para depois da liminar.' } },
      required: ['pagamento'],
      additionalProperties: false,
    },
  },
  {
    name: 'recusar_proposta',
    description: 'Só na fase de proposta: a pessoa disse que não quer seguir. Registra o motivo e encerra com a porta aberta.',
    strict: true,
    input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'], additionalProperties: false },
  },
  {
    name: 'encaminhar_advogado',
    description: 'Transfere a conversa para um advogado humano e ENCERRA o atendimento automático (a pessoa fica esperando). Use só quando a pessoa pedir claramente para falar com advogado ou pessoa, quando houver risco à vida ou ameaça física, ou quando o caso estiver fora da triagem (processo já em andamento, penhora, dívida de empresa, menor de idade). Tristeza, culpa ou desabafo não são motivo: acolha e continue.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string' } },
      required: ['motivo'],
      additionalProperties: false,
    },
  },
];

let _client = null;
function client() {
  if (_client) return _client;
  _client = new Anthropic();
  return _client;
}

// Converte o histórico do banco (se_mensagens) em turnos user/assistant.
export function montarMensagens(historico, textoAtual) {
  const msgs = [];
  for (const m of historico) {
    if (!m.texto) continue;
    const role = m.direcao === 'in' ? 'user' : 'assistant';
    msgs.push({ role, content: m.texto });
  }
  msgs.push({ role: 'user', content: textoAtual });
  // Primeiro turno tem que ser do usuário.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

async function executar(nome, input, ctx) {
  if (nome === 'calcular_comprometimento') {
    const r = calcularComprometimento(input);
    ctx.calculo = r;
    return JSON.stringify(r);
  }
  if (nome === 'registrar_triagem') {
    ctx.triagem = { ...input, calculo: ctx.calculo ?? null, registrado_em: new Date().toISOString() };
    return 'ok';
  }
  if (nome === 'aceitar_proposta') {
    ctx.proposta = { aceita: true, pagamento: input.pagamento };
    return 'ok: contratação registrada. Responda em uma linha confirmando e dizendo que vai pedir os documentos agora; o pedido do primeiro documento sai automaticamente depois da sua mensagem.';
  }
  if (nome === 'recusar_proposta') {
    ctx.proposta = { aceita: false, motivo: input.motivo };
    return 'ok: registrado. Despeça-se com respeito, em uma ou duas linhas, dizendo que ela pode voltar quando quiser.';
  }
  if (nome === 'encaminhar_advogado') {
    ctx.handoff = input.motivo;
    return 'ok: a conversa será transferida; despeça-se em uma linha dizendo que um advogado continua.';
  }
  return `ferramenta desconhecida: ${nome}`;
}

// Roda um turno de triagem. Devolve { texto, triagem?, calculo?, handoff?, usage }.
export async function responder({ historico, textoAtual, fase = 'triagem', api = client() }) {
  const blocoFase = typeof FASES[fase] === 'function' ? FASES[fase]() : (FASES[fase] || '');
  const messages = montarMensagens(historico, textoAtual);
  const ctx = {};
  let usage = { input: 0, output: 0, cache_read: 0 };
  const texto = [];
  const useFallback = process.env.CLAUDE_FALLBACKS !== 'off';

  for (let i = 0; i < 6; i++) {
    const req = {
      model: MODEL,
      max_tokens: 2048, // resposta curta de WhatsApp; as ferramentas são pequenas
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }, ...(blocoFase ? [{ type: 'text', text: blocoFase }] : [])],
      tools: TOOLS,
      output_config: { effort: 'medium' },
      messages,
    };
    const response = useFallback
      ? await api.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await api.messages.create(req);

    usage.input += response.usage?.input_tokens ?? 0;
    usage.output += response.usage?.output_tokens ?? 0;
    usage.cache_read += response.usage?.cache_read_input_tokens ?? 0;

    if (response.stop_reason === 'refusal') {
      texto.push('Desculpe, não consigo ajudar com isso por aqui. Vou passar para a equipe.');
      ctx.handoff = `refusal:${response.stop_details?.category ?? ''}`;
      break;
    }

    for (const b of response.content) if (b.type === 'text' && b.text.trim()) texto.push(b.text.trim());

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const t of toolUses) {
      let out;
      try { out = await executar(t.name, t.input, ctx); }
      catch (e) { results.push({ type: 'tool_result', tool_use_id: t.id, content: `erro: ${e.message}`, is_error: true }); continue; }
      results.push({ type: 'tool_result', tool_use_id: t.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }

  return { texto: texto.join('\n\n') || 'Pode repetir? Não consegui entender.', triagem: ctx.triagem, calculo: ctx.calculo, handoff: ctx.handoff, proposta: ctx.proposta, usage };
}
