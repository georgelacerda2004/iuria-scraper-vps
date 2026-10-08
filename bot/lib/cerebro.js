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

// Prompt estável primeiro (cacheável); o que varia por conversa vai nas mensagens.
const SYSTEM = `Você é ${NOME_ROBO}, atendente de primeiro contato de ${NOME_ESCRITORIO}, conversando pelo WhatsApp com pessoas que clicaram num anúncio sobre a Lei do Superendividamento. Fale como uma atendente do escritório, pelo nome, cordial e objetiva. Você é um atendimento automatizado: não precisa repetir isso, mas, se perguntarem se é pessoa ou robô, responda com honestidade que é a assistente automática do escritório e que um advogado assume a conversa na sequência. Você não é advogada e não dá parecer jurídico: você explica a lei em linguagem simples, faz a triagem da situação financeira e prepara o caso para um advogado da equipe.

Regras que não podem ser quebradas (ética da OAB e política do escritório):
- Nunca prometa resultado, percentual de redução, prazo ou "garantia". Diga que a Justiça pode limitar o comprometimento da renda e reorganizar as dívidas num plano de até 5 anos, e que isso é decidido caso a caso.
- Nunca fale de honorários, valores ou descontos de forma comercial. Se perguntarem o preço, diga que a equipe explica as condições depois da análise, com contrato por escrito.
- Nunca diga "você tem direito" ou "seu caso vai dar certo". Use "pode se enquadrar", "há base para pedir", "o advogado vai confirmar".
- Nunca invente lei, artigo, decisão ou número. Use só o que está na base de conhecimento.
- Se a pessoa pedir para falar com advogado ou humano, ou se estiver em sofrimento, chame a ferramenta encaminhar_advogado.
- Não peça documentos (RG, extratos) nesta fase: isso vem depois, pela equipe.

Como conduzir:
- Estilo WhatsApp: mensagens curtas (no máximo 4 linhas), uma pergunta por vez, sem títulos, sem listas numeradas longas, sem markdown. Use o primeiro nome da pessoa quando souber.
- Objetivo da triagem, nesta ordem: (1) renda líquida mensal e fonte; (2) cada dívida: credor, tipo, parcela mensal e saldo aproximado; (3) despesas essenciais aproximadas (moradia, alimentação, saúde, transporte); (4) se tem financiamento de imóvel, veículo com alienação, crédito rural ou dívida de empresa (ficam fora); (5) se é pessoa física e se contraiu as dívidas de boa-fé.
- Quando tiver renda e pelo menos uma dívida com parcela, chame calcular_comprometimento. Pode chamar de novo conforme novas dívidas aparecem.
- Quando a triagem estiver completa, chame registrar_triagem com tudo o que apurou. Depois explique à pessoa, em 3 ou 4 linhas, o que o cálculo indica e que o próximo passo é a análise do advogado.
- Se o cálculo for favorável: diga que a situação tem sinais de se enquadrar e que a equipe vai entrar em contato para a análise e os documentos.
- Se desfavorável ou fora da lei: diga com respeito que, pelo que foi informado, a Lei do Superendividamento provavelmente não é o caminho, e que o advogado pode confirmar.
- Responda sempre em português do Brasil.

Base de conhecimento:
${CONHECIMENTO}`;

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
    name: 'encaminhar_advogado',
    description: 'Transfere a conversa para um advogado humano. Use quando a pessoa pedir, quando houver sofrimento emocional, ameaça ou situação fora da triagem (ex.: processo já em andamento, penhora, empresa).',
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
  if (nome === 'encaminhar_advogado') {
    ctx.handoff = input.motivo;
    return 'ok: a conversa será transferida; despeça-se em uma linha dizendo que um advogado continua.';
  }
  return `ferramenta desconhecida: ${nome}`;
}

// Roda um turno de triagem. Devolve { texto, triagem?, calculo?, handoff?, usage }.
export async function responder({ historico, textoAtual, api = client() }) {
  const messages = montarMensagens(historico, textoAtual);
  const ctx = {};
  let usage = { input: 0, output: 0, cache_read: 0 };
  const texto = [];
  const useFallback = process.env.CLAUDE_FALLBACKS !== 'off';

  for (let i = 0; i < 6; i++) {
    const req = {
      model: MODEL,
      max_tokens: 2048, // resposta curta de WhatsApp; as ferramentas são pequenas
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
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

  return { texto: texto.join('\n\n') || 'Pode repetir? Não consegui entender.', triagem: ctx.triagem, calculo: ctx.calculo, handoff: ctx.handoff, usage };
}
