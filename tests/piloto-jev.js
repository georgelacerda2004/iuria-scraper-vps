// Piloto Jev: compara a ordem original dos tribunais com a ordem do Jev.
//
// Chama o servidor já rodando (na VPS, onde os scrapers passam pelo anti-bot)
// com ranquear=true e grava um relatório pra avaliação humana.
//
// Uso:
//   SCRAPER_URL=https://scraper.iuria.com.br IURIA_SCRAPER_TOKEN=... \
//     node tests/piloto-jev.js [arquivo-de-buscas.txt] [tribunal]
//
// arquivo-de-buscas.txt: uma busca por linha (linhas vazias e # ignoradas).
// Sem arquivo, usa a lista de exemplo abaixo. Tribunal default: stj.
// Saída: resumo no terminal + piloto-jev-<timestamp>.json no diretório atual.

import { readFileSync, writeFileSync } from 'node:fs';

const BUSCAS_EXEMPLO = [
  'dano moral negativação indevida',
  'responsabilidade civil erro médico',
  'usucapião extraordinária requisitos',
  'prescrição intercorrente execução fiscal',
  'plano de saúde negativa de cobertura',
  'pensão alimentícia revisão desemprego',
  'rescisão indireta atraso salarial',
  'ICMS base de cálculo PIS COFINS',
  'guarda compartilhada alienação parental',
  'juros abusivos contrato bancário',
];

const url = (process.env.SCRAPER_URL || 'http://localhost:3000').replace(/\/$/, '');
const token = process.env.IURIA_SCRAPER_TOKEN;
const [, , arquivo, tribunal = 'stj'] = process.argv;

if (!token) {
  console.error('Defina IURIA_SCRAPER_TOKEN (e SCRAPER_URL se não for localhost).');
  process.exit(1);
}

const buscas = arquivo
  ? readFileSync(arquivo, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : BUSCAS_EXEMPLO;

const relatorio = [];
let custoTotal = 0;
let tokensTotal = 0;

for (const busca of buscas) {
  process.stdout.write(`\n== ${busca}\n`);
  let data;
  try {
    const res = await fetch(`${url}/buscar/${tribunal}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ busca, limit: 10, ranquear: true }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    console.log(`   ERRO: ${e.message}`);
    relatorio.push({ busca, erro: e.message });
    continue;
  }

  const rk = data.ranqueamento || {};
  if (rk.status !== 'ok') {
    console.log(`   ranqueamento ${rk.status}: ${rk.motivo || ''}`);
    relatorio.push({ busca, erro: `ranqueamento ${rk.status}: ${rk.motivo || ''}` });
    continue;
  }
  custoTotal += rk.custo_estimado_usd || 0;
  tokensTotal += rk.input_tokens || 0;

  const top = data.resultados.slice(0, 5);
  top.forEach((r, i) => {
    console.log(`   #${i + 1} (era #${r.posicaoOriginal}) nota ${r.relevancia.score.toFixed(2)}/${rk.notaMax}` +
      ` conf ${r.relevancia.confianca ?? '-'} | ${r.titulo} | ${(r.ementaResumida || '').slice(0, 90)}`);
  });
  const mudou = data.resultados.filter((r, i) => r.posicaoOriginal !== i + 1).length;
  console.log(`   ${mudou}/${data.resultados.length} mudaram de posição | ${rk.tempo_ms}ms | ${rk.input_tokens} tokens`);

  relatorio.push({
    busca,
    total: data.resultados.length,
    mudaramDePosicao: mudou,
    tempo_ms: rk.tempo_ms,
    input_tokens: rk.input_tokens,
    custo_estimado_usd: rk.custo_estimado_usd,
    // Pra avaliação humana: preencha "avaliacao" com "jev_melhor" | "original_melhor" | "igual".
    avaliacao: null,
    resultados: data.resultados.map((r, i) => ({
      posicaoJev: i + 1,
      posicaoOriginal: r.posicaoOriginal,
      nota: r.relevancia.score,
      confianca: r.relevancia.confianca,
      titulo: r.titulo,
      ementaResumida: r.ementaResumida,
      link: r.link,
    })),
  });
}

const ok = relatorio.filter((r) => !r.erro).length;
console.log(`\n===== ${ok}/${buscas.length} buscas ranqueadas | ${tokensTotal} tokens | ~US$ ${custoTotal.toFixed(6)} no total`);
if (ok) console.log(`      média por busca: ~US$ ${(custoTotal / ok).toFixed(6)}`);

const saida = `piloto-jev-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(saida, JSON.stringify({ tribunal, url, gerado: new Date().toISOString(), relatorio }, null, 2));
console.log(`Relatório: ${saida}`);
