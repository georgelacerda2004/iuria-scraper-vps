// Ranqueamento de relevância com o Jev (TypeSafe AI) — PILOTO.
//
// O Jev é um modelo de "decisão": recebe um estado (texto/JSON) + perguntas
// tipadas (choice / score / noul) e devolve respostas estruturadas com
// probabilidades. Não gera texto. Aqui usamos uma pergunta "score" pra dar
// nota de relevância de cada acórdão em relação à busca do usuário.
//
// Uma chamada por acórdão, em paralelo com limite de concorrência. O custo
// é por token de entrada (~US$0,042 por milhão), então 15 ementas saem por
// frações de centavo.
//
// Fail-open: qualquer erro (sem chave, timeout, 4xx/5xx) devolve os
// resultados na ordem original + status de erro. Nunca quebra a busca.
//
// Docs: https://docs.typesafe.ai/api

const JEV_URL = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = process.env.JEV_MODEL || 'jev-latest';
const PRECO_USD_POR_MILHAO_INPUT = 0.042; // só pra estimativa no log/resposta
const MAX_EMENTA_CHARS = 4000; // ementas enormes não ajudam a decidir relevância

// Escala ordenada: índice 0..3 vira a nota. Descrições em português porque
// o conteúdo avaliado é português — parte do objetivo do piloto é medir isso.
const CRITERIOS_RELEVANCIA = [
  'Irrelevante: o acórdão trata de outro assunto e não ajuda quem fez a busca',
  'Tangencial: menciona o tema da busca, mas o ponto central da decisão é outro',
  'Relevante: a decisão discute o tema da busca de forma substancial',
  'Muito relevante: a tese central da decisão responde diretamente à busca',
];
const NOTA_MAX = CRITERIOS_RELEVANCIA.length - 1;

export function jevHabilitado() {
  return Boolean(process.env.JEV_API_KEY);
}

// Retry com backoff exponencial em 429 (rate limit) e 529 (overloaded),
// como a documentação recomenda.
async function chamarJev(body, { apiKey, fetchImpl, timeoutMs, tentativas = 3 }) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    const res = await fetchImpl(JEV_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res.json();
    const detalhe = await res.text().catch(() => '');
    ultimoErro = new Error(`jev HTTP ${res.status}: ${detalhe.slice(0, 200)}`);
    if (res.status !== 429 && res.status !== 529) throw ultimoErro;
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw ultimoErro;
}

async function avaliarAcordao(busca, acordao, opts) {
  const data = await chamarJev({
    model: JEV_MODEL,
    state: {
      busca,
      acordao: {
        tribunal: acordao.tribunal,
        orgao: acordao.orgao,
        titulo: acordao.titulo,
        ementa: (acordao.ementa || '').slice(0, MAX_EMENTA_CHARS),
      },
    },
    questions: {
      relevancia: {
        type: 'score',
        instructions: 'Quão relevante é o `acordao` para a pesquisa de jurisprudência descrita em `busca`?',
        criteria: CRITERIOS_RELEVANCIA,
      },
    },
  }, opts);
  const r = data?.answers?.relevancia;
  if (!r || typeof r.score !== 'number') {
    throw new Error('jev: resposta sem answers.relevancia.score');
  }
  return {
    score: r.score,
    confianca: r.confidence ?? null,
    modelo: data.model,
    inputTokens: data.usage?.input_tokens ?? 0,
  };
}

// Executa fn em cada item com no máximo `limite` promessas simultâneas.
async function mapComLimite(itens, limite, fn) {
  const saida = new Array(itens.length);
  let proximo = 0;
  async function worker() {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, worker));
  return saida;
}

// Retorna { resultados, ranqueamento }.
// resultados: mesmos objetos + campos `relevancia` e `posicaoOriginal`,
// ordenados por relevância decrescente (empate mantém ordem original).
export async function ranquearPorRelevancia(busca, resultados, {
  apiKey = process.env.JEV_API_KEY,
  fetchImpl = fetch,
  concorrencia = 5,
  timeoutMs = 15000,
} = {}) {
  const t0 = Date.now();
  const base = { provedor: 'jev', notaMax: NOTA_MAX };

  if (!apiKey) {
    return { resultados, ranqueamento: { ...base, status: 'desabilitado', motivo: 'JEV_API_KEY não configurada' } };
  }
  if (!resultados.length) {
    return { resultados, ranqueamento: { ...base, status: 'ok', tempo_ms: 0, input_tokens: 0, custo_estimado_usd: 0 } };
  }

  try {
    const avaliacoes = await mapComLimite(resultados, concorrencia, (a) =>
      avaliarAcordao(busca, a, { apiKey, fetchImpl, timeoutMs }));

    const inputTokens = avaliacoes.reduce((s, a) => s + a.inputTokens, 0);
    const ranqueados = resultados
      .map((a, i) => ({
        ...a,
        posicaoOriginal: i + 1,
        relevancia: {
          score: Number(avaliacoes[i].score.toFixed(3)),
          confianca: avaliacoes[i].confianca,
        },
      }))
      .sort((x, y) => y.relevancia.score - x.relevancia.score || x.posicaoOriginal - y.posicaoOriginal);

    return {
      resultados: ranqueados,
      ranqueamento: {
        ...base,
        status: 'ok',
        modelo: avaliacoes[0].modelo,
        tempo_ms: Date.now() - t0,
        input_tokens: inputTokens,
        custo_estimado_usd: Number(((inputTokens / 1e6) * PRECO_USD_POR_MILHAO_INPUT).toFixed(8)),
      },
    };
  } catch (err) {
    console.warn('[jev] falhou, mantendo ordem original:', err.message);
    return {
      resultados,
      ranqueamento: { ...base, status: 'erro', motivo: err.message, tempo_ms: Date.now() - t0 },
    };
  }
}
