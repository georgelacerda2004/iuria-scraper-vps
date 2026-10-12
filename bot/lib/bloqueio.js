// Bloqueio da conta do WhatsApp pela Meta (erro 131031 "Business Account locked"): enquanto durar, não adianta
// mandar retomadas, elas falham e queimam a sequência de lembretes do lead. O webhook marca, os envios consultam.
const CODIGOS = new Set([131031]);
const JANELA_MS = 6 * 3600_000;
let ate = 0;
let avisadoEm = -Infinity;

export function erroDeBloqueio(erros = []) { return erros.some(e => CODIGOS.has(Number(e.code))); }
export function marcarBloqueio(agora = Date.now()) { ate = agora + JANELA_MS; const novo = agora - avisadoEm > JANELA_MS; if (novo) avisadoEm = agora; return novo; }
export function contaBloqueada(agora = Date.now()) { return agora < ate; }
export function _reset() { ate = 0; avisadoEm = -Infinity; }
