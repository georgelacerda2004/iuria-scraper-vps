// Mercado de indicação: o operador oferece um lead qualificado (com consentimento expresso da pessoa) aos
// advogados cadastrados; leilão com lance mínimo e janela de tempo; o vencedor paga (Asaas) e só então recebe
// o contato e a conversa; a Paula avisa a pessoa quem vai chamá-la. A plataforma só indica: a relação dali em
// diante, a ética profissional e o tratamento dos dados passam a ser do advogado (termo aceito no cadastro).
import { db, atualizarConversa, gravarMensagem, carregarHistorico } from './db.js';
import * as asaas from './asaas.js';
import { sendText } from './whatsapp.js';
import { enviarEmail, esc } from './email.js';
import { avisarOperador } from './iuria.js';

export const CFG = () => ({
  precoMinimo: Number(process.env.MERCADO_PRECO_MINIMO || 500),
  duracaoMin: Number(process.env.MERCADO_DURACAO_MIN || 60),
  incremento: Number(process.env.MERCADO_INCREMENTO || 50),
  prazoPagamentoMin: Number(process.env.MERCADO_PRAZO_PAGAMENTO_MIN || 120),
  prorrogaMin: 5,
  plataforma: process.env.PLATAFORMA_NOME || 'IURIA',
  url: (process.env.PLATAFORMA_URL || 'https://superendividamento-bot.onrender.com').replace(/\/+$/, ''),
});
const NOME_ROBO = () => process.env.NOME_ROBO || 'Paula';
export const TERMO_VERSAO = '2026-10-09';

// Etapas em que um lead pode ser oferecido: ainda não assinou nem pagou com o escritório.
export const ETAPAS_OFERTAVEIS = ['triagem', 'proposta', 'docs', 'desistiu', 'handoff', 'inviavel', 'encerrado', 'consentimento'];

const ddd = (w) => { const m = String(w || '').match(/^55(\d{2})/); return m ? m[1] : null; };
const REGIAO = { 11: 'Grande São Paulo', 12: 'Vale do Paraíba (SP)', 13: 'Baixada Santista (SP)', 14: 'Bauru/Marília (SP)', 15: 'Sorocaba (SP)', 16: 'Ribeirão Preto (SP)', 17: 'São José do Rio Preto (SP)', 18: 'Presidente Prudente (SP)', 19: 'Campinas (SP)', 21: 'Rio de Janeiro', 31: 'Belo Horizonte', 41: 'Curitiba', 47: 'Joinville/Blumenau', 48: 'Florianópolis', 51: 'Porto Alegre', 61: 'Brasília', 62: 'Goiânia', 71: 'Salvador', 81: 'Recife', 85: 'Fortaleza' };

// Brief anonimizado: sem nome e sem telefone. O nome da pessoa é removido do resumo da Paula.
export function montarBrief(c) {
  const t = c.triagem || {}; const calc = t.calculo || {};
  const nome = (c.nome_perfil || '').trim();
  const limpar = (s) => { let x = String(s || ''); for (const p of nome.split(/\s+/).filter(p => p.length > 2)) x = x.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[cliente]'); return x; };
  return {
    regiao: REGIAO[ddd(c.wa_id)] || (ddd(c.wa_id) ? `DDD ${ddd(c.wa_id)}` : null), uf: t.uf || null, fonte_renda: t.fonte_renda || null,
    renda: calc.renda_liquida ?? null, parcelas: calc.parcelas_mensais_consideradas ?? null, pct: calc.percentual_renda_comprometido ?? null, sobra: calc.sobra_mensal ?? null,
    credores: calc.credores_considerados ?? null, saldo: calc.saldo_total_considerado ?? null, indicativo: calc.indicativo || null, resultado: t.resultado || null,
    dividas: (t.dividas || []).map(d => ({ tipo: d.tipo, credor: d.credor, parcela: d.parcela_mensal, saldo: d.saldo_total })),
    resumo: limpar(t.resumo), preferencia_pagamento: t.pagamento || null, documentos: Object.keys(t.documentos || {}).length,
    etapa_na_oferta: c.etapa, primeiro_contato: c.criado_em, mensagens_trocadas: null,
  };
}

export async function criarOferta(conversaId, { criadoPor = 'painel', precoMinimo, duracaoMin } = {}) {
  const s = db(); const C = CFG();
  const { data: c } = await s.from('se_conversas').select('*').eq('id', conversaId).maybeSingle();
  if (!c) throw new Error('conversa não encontrada');
  if (!c.consentimento_indicacao_em) throw new Error('a pessoa ainda não autorizou a indicação');
  const { data: aberta } = await s.from('se_ofertas').select('id').eq('conversa_id', conversaId).in('status', ['aberta', 'aguardando_pagamento']).maybeSingle();
  if (aberta) throw new Error('já existe uma oferta em andamento para este lead');
  const brief = montarBrief(c);
  const { count } = await s.from('se_mensagens').select('id', { count: 'exact', head: true }).eq('conversa_id', conversaId);
  brief.mensagens_trocadas = count ?? null;
  const fechaEm = new Date(Date.now() + (duracaoMin || C.duracaoMin) * 60_000).toISOString();
  const { data: o, error } = await s.from('se_ofertas').insert({ conversa_id: conversaId, brief, preco_minimo: precoMinimo || C.precoMinimo, fecha_em: fechaEm, criado_por: criadoPor }).select().single();
  if (error) throw new Error(error.message);
  await atualizarConversa(conversaId, { oferta_id: o.id, etapa: 'em_oferta', etapa_anterior: c.etapa === 'em_oferta' ? c.etapa_anterior : c.etapa });
  notificarNovaOferta(o).catch(e => console.warn('[mercado] notificar:', e.message));
  return o;
}

async function advogadosAtivos() {
  const s = db();
  const { data } = await s.from('se_advogados').select('id,nome,email,token').eq('ativo', true).not('termo_aceito_em', 'is', null);
  return data || [];
}

export function resumoBriefTexto(b) {
  return [
    b.regiao ? `Região: ${b.regiao}` : null, b.fonte_renda ? `Renda: ${b.fonte_renda}` : null,
    b.renda != null ? `Renda líquida R$ ${b.renda} · parcelas R$ ${b.parcelas} (${b.pct}%) · sobra R$ ${b.sobra}` : null,
    b.credores != null ? `${b.credores} credor(es) · saldo aprox. R$ ${b.saldo}` : null,
    b.indicativo ? `Indicativo da triagem: ${b.indicativo}` : null, b.preferencia_pagamento ? `Preferência de honorários: ${b.preferencia_pagamento}` : null,
    b.resumo ? `Resumo: ${b.resumo}` : null,
  ].filter(Boolean).join('\n');
}

const hora = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

async function notificarNovaOferta(o) {
  const C = CFG(); const advs = await advogadosAtivos();
  const link = `${C.url}/parceiros/painel`;
  const txt = resumoBriefTexto(o.brief);
  await Promise.all(advs.map(a => enviarEmail({
    para: a.email, assunto: `Novo caso de superendividamento disponível (lance mínimo R$ ${o.preco_minimo})`,
    texto: `Olá, ${a.nome}.\n\nUm novo caso qualificado pela ${NOME_ROBO()} está aberto para indicação até ${hora(o.fecha_em)}.\n\n${txt}\n\nVer e dar lance: ${link}?t=${a.token}\n\n${C.plataforma}`,
    html: `<p>Olá, ${esc(a.nome)}.</p><p>Um novo caso qualificado pela ${NOME_ROBO()} está aberto para indicação até <b>${esc(hora(o.fecha_em))}</b>.</p><pre style="white-space:pre-wrap;font-family:inherit">${esc(txt)}</pre><p><a href="${link}?t=${a.token}">Ver e dar lance</a></p><p>${esc(C.plataforma)}</p>`,
  })));
  await avisarOperador(`OFERTA ABERTA (lance mínimo R$ ${o.preco_minimo}, fecha ${hora(o.fecha_em)})\n${txt}\n${advs.length} advogado(s) avisado(s).`);
}

export async function lancar(ofertaId, advogadoId, valor) {
  const s = db(); const C = CFG();
  const { data: o } = await s.from('se_ofertas').select('*').eq('id', ofertaId).maybeSingle();
  if (!o || o.status !== 'aberta') throw new Error('oferta não está aberta');
  if (new Date(o.fecha_em) < new Date()) throw new Error('oferta encerrada');
  const { data: adv } = await s.from('se_advogados').select('id,ativo,termo_aceito_em').eq('id', advogadoId).maybeSingle();
  if (!adv?.ativo || !adv.termo_aceito_em) throw new Error('cadastro sem termo aceito');
  const { data: top } = await s.from('se_lances').select('valor,advogado_id').eq('oferta_id', ofertaId).order('valor', { ascending: false }).limit(1).maybeSingle();
  const minimo = top ? Number(top.valor) + C.incremento : Number(o.preco_minimo);
  valor = Number(valor);
  if (!(valor >= minimo)) throw new Error(`lance mínimo agora é R$ ${minimo}`);
  const { error } = await s.from('se_lances').insert({ oferta_id: ofertaId, advogado_id: advogadoId, valor });
  if (error) throw new Error(error.message);
  // Lance nos últimos 5 min prorroga 5 min.
  const patch = { atualizado_em: new Date().toISOString() };
  if (new Date(o.fecha_em).getTime() - Date.now() < C.prorrogaMin * 60_000) patch.fecha_em = new Date(Date.now() + C.prorrogaMin * 60_000).toISOString();
  await s.from('se_ofertas').update(patch).eq('id', ofertaId);
  return { ok: true, minimo_proximo: valor + C.incremento, fecha_em: patch.fecha_em || o.fecha_em };
}

// Fecha ofertas vencidas: vencedor paga em até N minutos; sem lance → expirada.
export async function fecharOfertas({ agora = new Date(), deps = {} } = {}) {
  const s = db(); if (!s) return 0;
  const { data: vencidas } = await s.from('se_ofertas').select('*').eq('status', 'aberta').lt('fecha_em', agora.toISOString()).limit(50);
  let n = 0;
  for (const o of vencidas || []) {
    try {
      const { data: top } = await s.from('se_lances').select('valor,advogado_id').eq('oferta_id', o.id).order('valor', { ascending: false }).limit(1).maybeSingle();
      if (!top) { await s.from('se_ofertas').update({ status: 'expirada', atualizado_em: agora.toISOString() }).eq('id', o.id); await avisarOperador(`Oferta ${o.id.slice(0, 8)} expirou sem lance. Reabra pelo painel se quiser.`); continue; }
      await cobrarVencedor(o, top, { agora, deps });
      n++;
    } catch (e) { console.error('[mercado] fechar', o.id, e.message); }
  }
  return n;
}

async function cobrarVencedor(o, top, { agora = new Date(), deps = {} } = {}) {
  const s = db(); const C = CFG();
  const { data: adv } = await s.from('se_advogados').select('*').eq('id', top.advogado_id).single();
  const cliente = deps.asaasCliente || asaas.garantirCliente; const cobranca = deps.asaasCobranca || asaas.criarCobranca;
  const customerId = adv.asaas_customer_id || await cliente({ nome: adv.nome, cpf: adv.cpf_cnpj, celular: adv.whatsapp, email: adv.email });
  if (!adv.asaas_customer_id) await s.from('se_advogados').update({ asaas_customer_id: customerId }).eq('id', adv.id);
  const pg = await cobranca({ customerId, valor: Number(top.valor), referencia: `LEAD|${o.id}`, descricao: `Indicação de caso qualificado (superendividamento) — ${C.plataforma}` });
  const ate = new Date(agora.getTime() + C.prazoPagamentoMin * 60_000).toISOString();
  await s.from('se_ofertas').update({ status: 'aguardando_pagamento', vencedor_id: adv.id, lance_vencedor: top.valor, asaas_payment_id: pg.id, url_pagamento: pg.url, pagamento_ate: ate, atualizado_em: agora.toISOString() }).eq('id', o.id);
  await (deps.email || enviarEmail)({
    para: adv.email, assunto: `Você venceu: pague R$ ${top.valor} para receber o contato`,
    texto: `Olá, ${adv.nome}. Seu lance de R$ ${top.valor} venceu. Pague até ${hora(ate)} para receber o contato e a conversa completa:\n${pg.url}\n\nDepois do pagamento, o caso aparece em ${C.url}/parceiros/painel?t=${adv.token}`,
    html: `<p>Olá, ${esc(adv.nome)}. Seu lance de <b>R$ ${esc(top.valor)}</b> venceu.</p><p>Pague até <b>${esc(hora(ate))}</b> para receber o contato e a conversa completa:</p><p><a href="${esc(pg.url)}">${esc(pg.url)}</a></p><p>Depois do pagamento, o caso aparece no seu <a href="${C.url}/parceiros/painel?t=${adv.token}">painel de parceiro</a>.</p>`,
  });
  await avisarOperador(`Oferta ${o.id.slice(0, 8)}: venceu ${adv.nome} (${adv.oab}/${adv.uf}) com R$ ${top.valor}. Cobrança enviada; prazo ${C.prazoPagamentoMin} min.`);
}

// Confirma pagamentos e libera o contato; vencedor que não pagou perde para o próximo lance.
export async function confirmarPagamentos({ agora = new Date(), deps = {} } = {}) {
  const s = db(); if (!s) return 0;
  const { data: pend } = await s.from('se_ofertas').select('*').eq('status', 'aguardando_pagamento').limit(50);
  let n = 0;
  for (const o of pend || []) {
    try {
      const r = await (deps.consultarPagamento || asaas.consultarPorReferencia)(`LEAD|${o.id}`);
      if (r.pago) { await liberar(o, { agora, deps }); n++; continue; }
      if (new Date(o.pagamento_ate) < agora) {
        const { data: lances } = await s.from('se_lances').select('valor,advogado_id').eq('oferta_id', o.id).neq('advogado_id', o.vencedor_id).order('valor', { ascending: false }).limit(1);
        await avisarOperador(`Oferta ${o.id.slice(0, 8)}: vencedor não pagou no prazo.${lances?.[0] ? ' Passando para o próximo lance.' : ' Sem outro lance: expirada.'}`);
        if (lances?.[0]) await cobrarVencedor(o, lances[0], { agora, deps });
        else await s.from('se_ofertas').update({ status: 'expirada', atualizado_em: agora.toISOString() }).eq('id', o.id);
      }
    } catch (e) { console.error('[mercado] pagamento', o.id, e.message); }
  }
  return n;
}

export function mensagemIndicacao(c, adv) {
  const nome = (c.nome_perfil || '').split(' ')[0];
  const tratamento = /^dr/i.test(adv.nome) ? adv.nome : `Dr(a). ${adv.nome}`;
  return `${nome ? nome + ', b' : 'B'}oa notícia: o seu caso foi encaminhado para ${tratamento}, advogado(a) inscrito(a) na OAB/${adv.uf} ${adv.oab}, que vai dar continuidade ao seu atendimento. Ele(a) vai te chamar por aqui ou pelo telefone${adv.whatsapp ? ' ' + adv.whatsapp : ''}. A partir de agora, é com ele(a). Eu, ${NOME_ROBO()}, fico por aqui torcendo por você. 🙏`;
}

async function liberar(o, { agora = new Date(), deps = {} } = {}) {
  const s = db(); const C = CFG();
  const { data: adv } = await s.from('se_advogados').select('*').eq('id', o.vencedor_id).single();
  const { data: c } = await s.from('se_conversas').select('*').eq('id', o.conversa_id).single();
  await s.from('se_ofertas').update({ status: 'vendida', pago_em: agora.toISOString(), liberado_em: agora.toISOString(), atualizado_em: agora.toISOString() }).eq('id', o.id);
  await atualizarConversa(c.id, { etapa: 'indicado', indicado_para: adv.id, indicado_em: agora.toISOString() });
  const texto = mensagemIndicacao(c, adv);
  try { const out = await (deps.sendText || sendText)(c.wa_id, texto); await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: 'text', texto, waMessageId: out?.messages?.[0]?.id }); }
  catch (e) { console.warn('[mercado] aviso à pessoa falhou (fora da janela?):', e.message); }
  const tel = `+${c.wa_id}`;
  await (deps.email || enviarEmail)({
    para: adv.email, assunto: `Contato liberado: ${c.nome_perfil || 'cliente'} (${tel})`,
    texto: `Pagamento confirmado. Contato: ${c.nome_perfil || ''} ${tel} (WhatsApp: https://wa.me/${c.wa_id}).\n\nA pessoa foi avisada pela ${NOME_ROBO()} de que você vai chamá-la. Conversa completa, cálculo e documentos em: ${C.url}/parceiros/painel?t=${adv.token}\n\nLembrete do termo: a partir daqui a relação com o cliente, a ética profissional e o tratamento dos dados são de sua responsabilidade.`,
    html: `<p>Pagamento confirmado.</p><p><b>Contato:</b> ${esc(c.nome_perfil || '')} ${esc(tel)} · <a href="https://wa.me/${c.wa_id}">abrir no WhatsApp</a></p><p>A pessoa foi avisada pela ${NOME_ROBO()} de que você vai chamá-la. Conversa completa, cálculo e documentos no seu <a href="${C.url}/parceiros/painel?t=${adv.token}">painel de parceiro</a>.</p><p><small>Lembrete do termo: a partir daqui a relação com o cliente, a ética profissional e o tratamento dos dados são de sua responsabilidade.</small></p>`,
  });
  await avisarOperador(`LEAD INDICADO ✅ ${c.nome_perfil || c.wa_id} → ${adv.nome} (${adv.oab}/${adv.uf}) por R$ ${o.lance_vencedor}. Contato liberado e pessoa avisada.`);
}

// O que o parceiro vê: ofertas abertas (só o brief) e os casos que comprou (contato e conversa).
export async function visaoParceiro(adv) {
  const s = db();
  const { data: abertas } = await s.from('se_ofertas').select('id,brief,preco_minimo,fecha_em,status,vencedor_id,lance_vencedor,url_pagamento,pagamento_ate').in('status', ['aberta', 'aguardando_pagamento']).order('fecha_em', { ascending: true });
  const ids = (abertas || []).map(o => o.id);
  const { data: lances } = ids.length ? await s.from('se_lances').select('oferta_id,advogado_id,valor').in('oferta_id', ids).order('valor', { ascending: false }) : { data: [] };
  const ofertas = (abertas || []).map(o => {
    const ls = (lances || []).filter(l => l.oferta_id === o.id);
    const meu = ls.filter(l => l.advogado_id === adv.id).map(l => Number(l.valor)).sort((a, b) => b - a)[0] ?? null;
    const top = ls[0] ? Number(ls[0].valor) : null;
    return { id: o.id, brief: o.brief, preco_minimo: Number(o.preco_minimo), fecha_em: o.fecha_em, status: o.status, lances: ls.length, maior_lance: top, meu_lance: meu, lidero: ls[0]?.advogado_id === adv.id, sou_vencedor: o.vencedor_id === adv.id, url_pagamento: o.vencedor_id === adv.id ? o.url_pagamento : null, pagamento_ate: o.vencedor_id === adv.id ? o.pagamento_ate : null, minimo_proximo: top ? top + CFG().incremento : Number(o.preco_minimo) };
  });
  const { data: compradas } = await s.from('se_ofertas').select('id,conversa_id,brief,lance_vencedor,pago_em').eq('vencedor_id', adv.id).eq('status', 'vendida').order('pago_em', { ascending: false });
  const casos = [];
  for (const o of compradas || []) {
    const { data: c } = await s.from('se_conversas').select('id,wa_id,nome_perfil,triagem,criado_em').eq('id', o.conversa_id).single();
    const mensagens = await carregarHistorico(c.id, 300);
    casos.push({ oferta_id: o.id, valor: Number(o.lance_vencedor), pago_em: o.pago_em, nome: c.nome_perfil, telefone: `+${c.wa_id}`, wa_id: c.wa_id, triagem: c.triagem, mensagens, brief: o.brief });
  }
  return { ofertas, casos };
}
