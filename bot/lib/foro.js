// Foro competente pelo CEP. Na Capital (São Paulo) o TJSP divide a cidade em Foros Regionais, e o
// peticionamento precisa do regional certo (senão sai no Central e o réu pode arguir incompetência).
// Fonte: Competência Territorial do TJSP (mesma consulta do site). Resultado em cache por CEP.
const cache = new Map();
const URL_TJSP = 'https://www.tjsp.jus.br/App/CompetenciaTerritorial/Home/ListarCompetencias';

// Devolve { foro, fonte } ou null. `foro` no formato que a fila usa, ex.: "Foro Regional do Butantã".
export async function foroPorCep(cep, { fetcher = fetch, timeoutMs = 10_000 } = {}) {
  const dig = String(cep || '').replace(/\D/g, '');
  if (dig.length !== 8) return null;
  if (cache.has(dig)) return cache.get(dig);
  let out = null;
  try {
    const r = await fetcher(URL_TJSP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, text/html;q=0.9', 'User-Agent': 'Mozilla/5.0 (superendividamento-bot)' },
      body: `busca=${dig}&tipoBusca=1`,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const texto = await r.text();
    out = extrairForo(texto);
  } catch (e) { console.warn('[foro] consulta TJSP falhou:', e.message); }
  if (out) cache.set(dig, out);
  return out;
}

// Aceita JSON ou HTML: procura "Foro Regional ..." / "Foro Central ..." ligado à competência cível.
export function extrairForo(texto) {
  const t = String(texto || '');
  // JSON com campos tipo "Foro": "Foro Regional XV - Butantã" ou "Competencia"/"Descricao"
  try {
    const j = JSON.parse(t);
    const lista = Array.isArray(j) ? j : (j?.data || j?.Competencias || j?.competencias || []);
    for (const item of lista) {
      const s = JSON.stringify(item);
      const m = s.match(/Foro (Regional[^"\\]+|Central[^"\\]*)/i);
      if (m && /c[ií]vel|^(?!.*(fam[ií]lia|criminal|fazenda|juizado))/i.test(s)) return { foro: limpar(m[0]), fonte: 'tjsp' };
    }
  } catch { /* não é JSON */ }
  const semTags = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // Prefere a ocorrência ligada a "Cível"; senão a primeira
  const todas = [...semTags.matchAll(/Foro (Regional[^.;,<\n]{3,60}|Central C[ií]vel)/gi)].map(m => limpar(m[0]));
  if (!todas.length) return null;
  const civel = todas.find(f => /c[ií]vel/i.test(semTags.slice(Math.max(0, semTags.indexOf(f) - 80), semTags.indexOf(f) + 120)));
  return { foro: civel || todas[0], fonte: 'tjsp' };
}

const limpar = s => String(s).replace(/\s+/g, ' ').replace(/[\s.;,-]+$/, '').trim();

// Capital de SP: jurisdição = foro regional pelo CEP; demais comarcas: "Foro de <Cidade>".
export async function jurisdicaoPara({ cidade, uf, cep }, deps = {}) {
  const ehCapital = /^s[ãa]o paulo$/i.test(String(cidade || '').trim()) && (!uf || /^sp$/i.test(uf));
  if (!ehCapital) return cidade ? `Foro de ${cidade}` : null;
  const r = await (deps.foroPorCep || foroPorCep)(cep);
  return r?.foro ? `São Paulo - ${r.foro}` : 'São Paulo - Foro Central Cível';
}
