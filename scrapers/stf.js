// Scraper STF — Jurisprudência STF (SPA)
// TODO Fase 4: implementar usando https://jurisprudencia.stf.jus.br/
// SPA Angular, precisa esperar XHR /api/search/acordaos retornar.
// Estratégia: navegar pra ?queryString=TERMO, aguardar resultados renderizarem,
// interceptar response JSON da /api/search ou ler DOM final.

export async function stf(_browser, { busca }) {
  console.log(`[stf] TODO scraper não implementado (busca: "${busca}")`);
  return [];
}
