// Cálculo puro do comprometimento de renda. Sem rede, sem banco: testável.
export const MINIMO_EXISTENCIAL = 600; // Decreto 11.567/2023

// Tipos de dívida que a lei exclui (ou que o decreto tira do cálculo do mínimo existencial).
const EXCLUIDAS = new Set(['financiamento_imobiliario', 'garantia_real', 'credito_rural', 'credito_empresa', 'aval', 'luxo']);
const TIPOS = ['cartao', 'emprestimo_pessoal', 'consignado', 'cheque_especial', 'crediario', 'servicos', 'financiamento_veiculo', 'financiamento_imobiliario', 'garantia_real', 'credito_rural', 'credito_empresa', 'aval', 'luxo', 'outro'];

export function tiposDivida() { return TIPOS; }

export function calcularComprometimento({ renda_liquida, despesas_essenciais = 0, dividas = [] }) {
  const renda = Number(renda_liquida) || 0;
  const despesas = Number(despesas_essenciais) || 0;
  const consideradas = dividas.filter(d => !EXCLUIDAS.has(d.tipo));
  const excluidas = dividas.filter(d => EXCLUIDAS.has(d.tipo));
  const parcelas = consideradas.reduce((s, d) => s + (Number(d.parcela_mensal) || 0), 0);
  const parcelasExcluidas = excluidas.reduce((s, d) => s + (Number(d.parcela_mensal) || 0), 0);
  const saldoTotal = consideradas.reduce((s, d) => s + (Number(d.saldo_total) || 0), 0);
  const pct = renda > 0 ? Math.round((parcelas / renda) * 1000) / 10 : null;
  const sobra = renda - parcelas - parcelasExcluidas - despesas;

  // Sinais, não veredito. A análise final é do advogado.
  const sinais = [];
  if (pct !== null && pct >= 30) sinais.push('parcelas_acima_30pct_renda');
  if (sobra < MINIMO_EXISTENCIAL) sinais.push('sobra_abaixo_minimo_existencial');
  if (consideradas.length >= 2) sinais.push('multiplos_credores');
  if (excluidas.length) sinais.push('tem_dividas_fora_da_lei');
  if (consideradas.length === 0) sinais.push('nenhuma_divida_de_consumo');

  let indicativo = 'inconclusivo';
  if (consideradas.length > 0 && (pct >= 30 || sobra < MINIMO_EXISTENCIAL)) indicativo = 'favoravel';
  else if (consideradas.length > 0 && pct !== null && pct < 20 && sobra >= MINIMO_EXISTENCIAL * 2) indicativo = 'desfavoravel';

  return {
    renda_liquida: renda,
    parcelas_mensais_consideradas: parcelas,
    parcelas_mensais_excluidas: parcelasExcluidas,
    saldo_total_considerado: saldoTotal,
    percentual_renda_comprometido: pct,
    sobra_mensal: Math.round(sobra * 100) / 100,
    minimo_existencial: MINIMO_EXISTENCIAL,
    credores_considerados: consideradas.length,
    credores_excluidos: excluidas.map(d => d.credor),
    sinais,
    indicativo, // favoravel | desfavoravel | inconclusivo — sempre sujeito à análise do advogado
  };
}
