// Briefing para o advogado quando uma conversa passa para atendimento humano:
// quem é, número, de onde veio, por que passou, o que a triagem apurou e as últimas mensagens.

const NOME_ROBO = process.env.NOME_ROBO || 'Paula';

export function formatarTelefone(waId) {
  const d = String(waId || '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4), n = d.slice(4);
    return `+55 ${ddd} ${n.length === 9 ? n.slice(0, 5) + '-' + n.slice(5) : n.slice(0, 4) + '-' + n.slice(4)}`;
  }
  return '+' + d;
}

const brl = v => (v == null ? '-' : 'R$ ' + Number(v).toFixed(2).replace('.', ','));
const hora = iso => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

export function montarBriefing({ conversa, mensagens = [], motivo }) {
  const t = conversa.triagem || {};
  const c = t.calculo || {};
  const nome = t.dados?.nome || conversa.nome_perfil || 'sem nome';
  const origem = conversa.ad_id ? `anúncio ${conversa.referral?.headline ? `"${conversa.referral.headline}"` : conversa.ad_id}` : 'contato direto';
  const linhas = [
    `🔔 Lead passou para atendimento humano`,
    `Nome: ${nome}`,
    `WhatsApp: ${formatarTelefone(conversa.wa_id)} · https://wa.me/${conversa.wa_id}`,
    `Origem: ${origem} · início ${hora(conversa.criado_em)} · passou ${hora(conversa.handoff_em || new Date().toISOString())}`,
    `Motivo: ${motivo || conversa.handoff_motivo || 'pediu para falar com uma pessoa'}`,
  ];
  if (c.renda_liquida != null || c.parcelas_mensais_consideradas != null) {
    linhas.push(`Triagem: renda líquida ${brl(c.renda_liquida)}; parcelas ${brl(c.parcelas_mensais_consideradas)}/mês` +
      (c.percentual_renda_comprometido != null ? ` (${c.percentual_renda_comprometido}% da renda)` : '') +
      (c.sobra_mensal != null ? `; sobra ${brl(c.sobra_mensal)} (mínimo existencial ${brl(c.minimo_existencial)})` : '') +
      (c.credores_considerados != null ? `; ${c.credores_considerados} credor(es)` : '') +
      (c.saldo_total_considerado != null ? `; saldo ~${brl(c.saldo_total_considerado)}` : '') +
      (c.indicativo ? `; indicativo ${c.indicativo}` : '') + '.');
  }
  if (t.resumo) linhas.push(`Resumo: ${t.resumo}`);
  const ultimas = [...mensagens].filter(m => m.texto).sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em)).slice(-8);
  if (ultimas.length) {
    linhas.push('Últimas mensagens:');
    for (const m of ultimas) linhas.push(`${hora(m.criado_em).slice(-5)} ${m.direcao === 'in' ? nome.split(' ')[0] : NOME_ROBO}: ${String(m.texto).replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  linhas.push(`A ${NOME_ROBO} fica em silêncio nessa conversa até a equipe responder.`);
  return linhas.join('\n');
}
