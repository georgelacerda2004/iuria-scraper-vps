// Fechamento do caso: projeção do plano (com base na lei e nos números da triagem), checklist do que
// já está pronto e do que falta para protocolar, e o briefing de fechamento para o advogado.
// Tudo aqui é projeção, nunca promessa: a decisão é do juiz e da conciliação com os credores.
import { MINIMO_EXISTENCIAL } from './calculo.js';
import { modoEntrada } from './captacao.js';

export const PRAZO_MAX_MESES = 60;         // art. 104-A §4º: plano de até 5 anos
export const TETO_RENDA_SUGERIDO = 0.30;   // referência usual nos pedidos de liminar (30 % da renda líquida)

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Projeção do plano de pagamento a partir do cálculo da triagem.
export function projetarPlano(triagem = {}) {
  const c = triagem.calculo || {};
  const renda = Number(c.renda_liquida || 0);
  const parcelasAtuais = Number(c.parcelas_mensais_consideradas || 0);
  const saldo = Number(c.saldo_total_considerado || 0);
  const despesas = Number(triagem.despesas_essenciais || 0);
  if (!renda || !parcelasAtuais) return null;

  // Capacidade: o que sobra depois de preservar o mínimo existencial (ou as despesas essenciais, se maiores).
  const reserva = Math.max(MINIMO_EXISTENCIAL, despesas);
  const capacidade = Math.max(0, renda - reserva);
  const tetoRenda = renda * TETO_RENDA_SUGERIDO;
  const parcelaProposta = r2(Math.max(0, Math.min(capacidade, tetoRenda)));
  const meses = parcelaProposta > 0 && saldo > 0 ? Math.min(PRAZO_MAX_MESES, Math.ceil(saldo / parcelaProposta)) : PRAZO_MAX_MESES;
  const totalNoPlano = r2(parcelaProposta * meses);
  const cabeNoPrazo = saldo > 0 ? totalNoPlano >= saldo : true;
  const reducaoMensal = r2(parcelasAtuais - parcelaProposta);
  const reducaoPct = parcelasAtuais ? Math.round((reducaoMensal / parcelasAtuais) * 1000) / 10 : null;
  const sobraDepois = r2(renda - parcelaProposta - despesas);

  return {
    renda, parcelas_atuais: parcelasAtuais, pct_atual: c.percentual_renda_comprometido ?? null, saldo, despesas, minimo_existencial: MINIMO_EXISTENCIAL,
    parcela_proposta: parcelaProposta, pct_proposto: renda ? Math.round((parcelaProposta / renda) * 1000) / 10 : null,
    reducao_mensal: reducaoMensal, reducao_pct: reducaoPct, sobra_depois: sobraDepois,
    prazo_meses: meses, total_no_plano: totalNoPlano, cabe_no_prazo: cabeNoPrazo,
    valor_da_causa: saldo || null,
    pedidos: {
      liminar: `limitar descontos e cobranças das dívidas de consumo a R$ ${parcelaProposta.toFixed(2)}/mês (${Math.round((parcelaProposta / renda) * 100)}% da renda) e suspender a exigibilidade até a audiência`,
      conciliacao: `audiência global com ${c.credores_considerados ?? 'os'} credor(es) e plano de ${meses} meses, parcela de R$ ${parcelaProposta.toFixed(2)}`,
      compulsorio: cabeNoPrazo ? 'plano judicial compulsório (art. 104-B) com quitação do principal em até 5 anos, se não houver acordo' : 'saldo não cabe em 60 meses com a parcela proposta: o plano compulsório exigirá redução do principal, juros ou prazo maior por acordo',
    },
    aviso: 'Projeção com base na Lei 14.181/2021 e nos dados informados pela pessoa. Depende de decisão judicial e da conciliação; não é garantia.',
  };
}

const ok = (feito, rotulo, detalhe = '') => ({ feito: !!feito, rotulo, detalhe });

// Checklist do que já existe e do que falta para o advogado protocolar.
export function checklistFechamento({ conversa, assinaturas = [], processo = null, distribuicao = null }) {
  const t = conversa.triagem || {}; const d = t.documentos || {};
  const ass = (nome) => assinaturas.find(a => new RegExp(nome, 'i').test(a.nome));
  const assOk = (nome) => { const a = ass(nome); return a ? a.status === 'assinado' : false; };
  const dividasDocs = Array.isArray(d.dividas) ? d.dividas.length : 0;
  const modo = modoEntrada(t);
  const itens = [
    ok(t.resultado === 'favoravel', 'Triagem favorável', t.resultado || 'não concluída'),
    ok(t.pagamento, 'Proposta aceita', t.pagamento ? ({ agora: 'entrada agora', apos_liminar: 'entrada após a liminar', ad_exitum: 'ad exitum' })[t.pagamento] : 'pendente'),
    ok(d.pessoal?.path, 'RG ou CNH', d.pessoal?.pulado ? 'pulado: pedir' : ''),
    ok(t.dados?.cpf, 'CPF'),
    ok(d.endereco?.path, 'Comprovante de endereço', d.endereco?.pulado ? 'pulado: pedir' : ''),
    ok(d.renda?.path, 'Comprovante de renda', d.renda?.pulado ? 'pulado: pedir' : ''),
    ok(dividasDocs > 0, 'Comprovantes das dívidas', dividasDocs ? `${dividasDocs} arquivo(s)` : 'nenhum: pedir extratos, faturas ou contratos'),
    ok(conversa.cliente_id, 'Cliente cadastrado no IURIA'),
    ok(assOk('Procura'), 'Procuração assinada', ass('Procura')?.status || 'não enviada'),
    ok(assOk('Contrato'), 'Contrato de honorários assinado', ass('Contrato')?.status || 'não enviado'),
    ok(assOk('Superendividamento'), 'Declaração de superendividamento assinada', ass('Superendividamento')?.status || 'não enviada'),
    ok(assOk('Hipossufici'), 'Declaração de hipossuficiência (justiça gratuita) assinada', ass('Hipossufici')?.status || 'não enviada'),
    ok(modo !== 'agora' || conversa.pago_em, 'Entrada', modo === 'agora' ? (conversa.pago_em ? 'paga' : 'pendente') : modo === 'apos_liminar' ? 'combinada para depois da liminar' : 'sem entrada (ad exitum)'),
    ok(conversa.processo_id, 'Processo e entrevista criados no IURIA'),
    ok(distribuicao, 'Petição inicial gerada e distribuição em rascunho', distribuicao ? `rascunho ${String(distribuicao.id || '').slice(0, 8)}` : 'gerada após assinaturas'),
    ok(false, 'Revisão e assinatura com token (advogado)', 'CNPJ e endereço dos credores, conferência do valor da causa, assinatura A3'),
  ];
  const obrigatorios = itens.slice(0, -1);
  const faltam = obrigatorios.filter(i => !i.feito);
  return { itens, pronto_para_advogado: faltam.length === 0, faltam: faltam.map(i => i.rotulo), feitos: obrigatorios.length - faltam.length, total: obrigatorios.length };
}

const brl = (n) => n == null ? '—' : 'R$ ' + Number(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Briefing de fechamento em texto (painel e Telegram).
export function briefingFechamento({ conversa, plano, checklist }) {
  const t = conversa.triagem || {}; const c = t.calculo || {};
  const l = [];
  l.push(`${checklist.pronto_para_advogado ? 'FECHADO ✅ pronto para protocolar' : `EM FECHAMENTO · ${checklist.feitos}/${checklist.total} itens`} — ${conversa.nome_perfil || conversa.wa_id}`);
  if (t.resumo) l.push(`Caso: ${t.resumo}`);
  if (c.renda_liquida) l.push(`Hoje: renda ${brl(c.renda_liquida)} · parcelas ${brl(c.parcelas_mensais_considerada ?? c.parcelas_mensais_consideradas)} (${c.percentual_renda_comprometido}%) · sobra ${brl(c.sobra_mensal)} · ${c.credores_considerados} credor(es) · saldo ${brl(c.saldo_total_considerado)}`);
  if (plano) {
    l.push(`Plano proposto: parcela ${brl(plano.parcela_proposta)}/mês (${plano.pct_proposto}% da renda) por ${plano.prazo_meses} meses · redução de ${brl(plano.reducao_mensal)}/mês (${plano.reducao_pct}%) · sobra depois ${brl(plano.sobra_depois)}`);
    l.push(`Valor da causa: ${brl(plano.valor_da_causa)} · liminar: ${plano.pedidos.liminar}`);
    if (!plano.cabe_no_prazo) l.push(`Atenção: ${plano.pedidos.compulsorio}`);
  }
  l.push(checklist.faltam.length ? `Falta: ${checklist.faltam.join('; ')}.` : 'Nada falta da parte do cliente. Falta só a revisão e a assinatura do advogado.');
  return l.join('\n');
}
