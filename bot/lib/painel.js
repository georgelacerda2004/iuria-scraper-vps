// Painel de gestão (George): leads, medição da triagem, etapa, o que a Paula fez, gasto x conversão.
// Lê o banco e o Meta ao vivo. Protegido por senha (PAINEL_SENHA) enviada no header x-painel.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, atualizarConversa } from './db.js';
import { insightsPorAnuncio, leadsPorAnuncio } from './campanha.js';
import { statusAssinaturas } from './iuria.js';
import { criarOferta, ETAPAS_OFERTAVEIS } from './mercado.js';
import { projetarPlano, checklistFechamento, briefingFechamento } from './plano.js';
import { MSG } from './fluxo.js';
import { sendText } from './whatsapp.js';
import { gravarMensagem } from './db.js';
import { aprovar, reabrir, fila, pegar, registrarResultado } from './protocolo.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ETAPAS = ['novo', 'consentimento', 'triagem', 'proposta', 'docs', 'pagamento_assinatura', 'cliente', 'handoff', 'retomar', 'desistiu', 'inviavel', 'encerrado'];
export const ROTULO = {
  novo: 'Chegou', consentimento: 'Aguardando SIM', triagem: 'Em triagem', proposta: 'Proposta (Paula explicando)', docs: 'Mandando documentos',
  pagamento_assinatura: 'Pagamento / assinatura', cliente: 'Cliente', handoff: 'Com humano', retomar: 'Retomada agendada', desistiu: 'Não quis', inviavel: 'Fora da lei', encerrado: 'Saiu',
  consentimento_indicacao: 'Perguntando se pode indicar', em_oferta: 'Em oferta a advogados', indicado: 'Indicado a parceiro',
};
const ORDEM = Object.fromEntries(ETAPAS.map((e, i) => [e, i]));

let cacheMeta = { em: 0, dados: null };
async function meta() {
  if (Date.now() - cacheMeta.em < 5 * 60_000 && cacheMeta.dados) return cacheMeta.dados;
  if (!process.env.META_ADS_TOKEN || !process.env.META_AD_ACCOUNT_ID) return { hoje: [], semana: [], erro: 'META_ADS_TOKEN ausente' };
  try {
    const [hoje, semana] = await Promise.all([insightsPorAnuncio({ dias: 1 }), insightsPorAnuncio({ dias: 7 })]);
    cacheMeta = { em: Date.now(), dados: { hoje, semana } };
  } catch (e) { cacheMeta = { em: Date.now(), dados: { hoje: [], semana: [], erro: e.message } }; }
  return cacheMeta.dados;
}

// Temperatura: quão perto da contratação a Paula levou o lead. 'pronto' = tudo feito, falta só o advogado protocolar.
export function temperatura(c) {
  const t = c.triagem || {};
  if (c.etapa === 'cliente') return { nivel: 'pronto', rotulo: 'Pronto para o advogado', score: 100 };
  if (['desistiu', 'inviavel', 'encerrado'].includes(c.etapa)) return { nivel: 'frio', rotulo: 'Encerrado', score: 0 };
  let score = 0;
  if (c.consentimento_em) score += 10;
  if (t.calculo) score += 15;
  if (t.resultado === 'favoravel') score += 20; else if (t.resultado) score -= 20;
  if (t.pagamento) score += 15;
  score += Math.min(3, Object.keys(t.documentos || {}).length) * 5;
  if ((t.assinaturas || []).length) score += 10;
  if (c.assinado_em) score += 10;
  if (c.pago_em) score += 10;
  score = Math.max(0, Math.min(99, score));
  const nivel = score >= 60 ? 'quente' : score >= 30 ? 'morno' : 'frio';
  return { nivel, rotulo: { quente: 'Quente', morno: 'Morno', frio: 'Frio' }[nivel], score };
}

export function resumirConversa(c) {
  const t = c.triagem || {}; const calc = t.calculo || {};
  const temp = temperatura(c);
  return {
    temperatura: temp.nivel, temperatura_rotulo: temp.rotulo, score: temp.score,
    id: c.id, wa_id: c.wa_id, nome: c.nome_perfil || '', telefone: formatar(c.wa_id), etapa: c.etapa, rotulo: ROTULO[c.etapa] || c.etapa, ordem: ORDEM[c.etapa] ?? 99,
    ad_id: c.ad_id, origem: c.origem, criado_em: c.criado_em, ultima_msg_em: c.ultima_msg_em, ultima_entrada_em: c.ultima_entrada_em,
    consentiu: !!c.consentimento_em, resultado: t.resultado || null, indicativo: calc.indicativo || null,
    renda: calc.renda_liquida ?? null, parcelas: calc.parcelas_mensais_consideradas ?? null, pct: calc.percentual_renda_comprometido ?? null, sobra: calc.sobra_mensal ?? null,
    credores: calc.credores_considerados ?? null, saldo: calc.saldo_total_considerado ?? null, fonte_renda: t.fonte_renda || null, uf: t.uf || null, resumo: t.resumo || null,
    pagamento: t.pagamento || null, docs: Object.keys(t.documentos || {}).length, cpf: !!(t.dados?.cpf), assinaturas_total: (t.assinaturas || []).length,
    pago_em: c.pago_em, assinado_em: c.assinado_em, cliente_id: c.cliente_id, processo_id: c.processo_id,
    handoff_em: c.handoff_em, handoff_motivo: c.handoff_motivo, followup_n: c.followup_n || 0, followup_em: c.followup_em, recusa_motivo: t.recusa_motivo || null,
  };
}
const formatar = (w) => { const d = String(w || '').replace(/\D/g, ''); const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : w; };

export function funil(conversas) {
  const n = (f) => conversas.filter(f).length;
  return {
    total: n(() => true), anuncio: n(c => c.origem === 'ads_whatsapp'), consentiram: n(c => c.consentiu),
    triagem_fechada: n(c => c.resultado), favoraveis: n(c => c.resultado === 'favoravel'), proposta_aceita: n(c => c.pagamento),
    em_docs: n(c => c.etapa === 'docs'), aguardando: n(c => c.etapa === 'pagamento_assinatura'), clientes: n(c => c.etapa === 'cliente'),
    pagos: n(c => c.pago_em), quentes: n(c => c.temperatura === 'quente'), prontos: n(c => c.temperatura === 'pronto'), handoff: n(c => c.etapa === 'handoff'), desistiram: n(c => c.etapa === 'desistiu'), sem_resposta: n(c => ['novo', 'consentimento'].includes(c.etapa)),
    por_pagamento: { agora: n(c => c.pagamento === 'agora'), apos_liminar: n(c => c.pagamento === 'apos_liminar'), ad_exitum: n(c => c.pagamento === 'ad_exitum') },
  };
}

export function montarRouter({ senha = process.env.PAINEL_SENHA } = {}) {
  const r = express.Router();
  r.get('/', (_req, res) => res.sendFile(path.join(AQUI, '..', 'painel', 'index.html')));
  r.use('/api', (req, res, next) => {
    if (!senha) return res.status(503).json({ erro: 'PAINEL_SENHA não definida no Render' });
    // A senha vai no header; a rota da petição aceita ?senha= para abrir numa aba do navegador.
    const abreNoNavegador = req.path.startsWith('/peticao/') || req.path.startsWith('/arquivo');
    if (req.get('x-painel') !== senha && !(abreNoNavegador && req.query.senha === senha)) return res.status(401).json({ erro: 'senha inválida' });
    next();
  });
  // Arquivo do bucket "documentos" (PDF do pacote, recibo, print de erro): redireciona para um link assinado de 1 h.
  r.get('/api/arquivo', async (req, res) => {
    try {
      const s = db(); if (!s) return res.status(503).json({ erro: 'sem banco' });
      const p = String(req.query.path || '');
      if (!/^se-uploads\//.test(p)) return res.status(400).json({ erro: 'caminho inválido' });
      const { data, error } = await s.storage.from('documentos').createSignedUrl(p, 3600);
      if (error) return res.status(404).json({ erro: error.message });
      res.redirect(data.signedUrl);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  // Fila de protocolo: aprovação do advogado e API do robô do PC (ver docs/PROTOCOLO.md).
  r.post('/api/distribuicoes/:id/aprovar', async (req, res) => { try { res.json({ ok: true, progresso: await aprovar(req.params.id, { por: String(req.body?.por || 'painel') }) }); } catch (e) { res.status(400).json({ erro: e.message }); } });
  r.post('/api/distribuicoes/:id/reabrir', async (req, res) => { try { await reabrir(req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ erro: e.message }); } });
  r.get('/api/fila', async (req, res) => { try { res.json({ itens: await fila(req.query.incluir === 'pronta' ? { status: ['aprovada', 'em_protocolo', 'pronta'] } : {}) }); } catch (e) { res.status(500).json({ erro: e.message }); } });
  r.post('/api/fila/:id/pegar', async (req, res) => { try { await pegar(req.params.id, { robo: String(req.body?.robo || 'pc') }); res.json({ ok: true }); } catch (e) { res.status(409).json({ erro: e.message }); } });
  r.post('/api/fila/:id/resultado', express.json({ limit: '20mb' }), async (req, res) => { try { res.json({ ok: true, resultado: await registrarResultado(req.params.id, req.body || {}) }); } catch (e) { res.status(400).json({ erro: e.message }); } });
  // Petição gerada (HTML pronto para imprimir/exportar em PDF) de uma entrevista do IURIA.
  r.get('/api/peticao/:entrevistaId', async (req, res) => {
    try {
      const s = db(); if (!s) return res.status(503).json({ erro: 'sem banco' });
      const { data } = await s.from('inicial_entrevistas').select('status,peticao_html').eq('id', req.params.entrevistaId).maybeSingle();
      if (!data?.peticao_html) return res.status(404).json({ erro: data ? `petição ainda não gerada (status ${data.status})` : 'não achei' });
      res.type('html').send(data.peticao_html);
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  r.get('/api/resumo', async (_req, res) => {
    try {
      const s = db(); if (!s) return res.status(503).json({ erro: 'sem banco' });
      const { data, error } = await s.from('se_conversas').select('*').order('ultima_msg_em', { ascending: false }).limit(500);
      if (error) throw new Error(error.message);
      const conversas = (data || []).map(resumirConversa);
      // Situação do protocolo (distribuição) dos leads fechados, para o chip na lista.
      const pids = (data || []).map(c => c.processo_id).filter(Boolean);
      if (pids.length) {
        const { data: dists } = await s.from('distribuicoes').select('processo_id,status,numero_processo').in('processo_id', pids).order('created_at', { ascending: false });
        const porProc = {}; for (const d of dists || []) if (!porProc[d.processo_id]) porProc[d.processo_id] = d;
        (data || []).forEach((c, i) => { const d = porProc[c.processo_id]; if (d) { conversas[i].protocolo = d.status; conversas[i].numero_processo = d.numero_processo; } });
      }
      const [m, leads7] = await Promise.all([meta(), leadsPorAnuncio({ dias: 7 }).catch(() => ({}))]);
      const anuncios = (m.semana || []).map(a => {
        const h = (m.hoje || []).find(x => x.ad_id === a.ad_id) || {};
        const l = leads7[a.ad_id] || { leads: 0, qualificados: 0, pagos: 0 };
        return { ...a, hoje: { gasto: h.gasto || 0, conversas: h.conversas || 0, cliques: h.cliques || 0, impressoes: h.impressoes || 0 }, ...l,
          custo_conversa: a.conversas ? a.gasto / a.conversas : null, custo_lead: l.leads ? a.gasto / l.leads : null, custo_qualificado: l.qualificados ? a.gasto / l.qualificados : null, custo_pago: l.pagos ? a.gasto / l.pagos : null };
      });
      const tot = anuncios.reduce((s, a) => ({ gasto: s.gasto + a.gasto, hoje: s.hoje + a.hoje.gasto, conversas: s.conversas + a.conversas, leads: s.leads + a.leads, qualificados: s.qualificados + a.qualificados, pagos: s.pagos + a.pagos }), { gasto: 0, hoje: 0, conversas: 0, leads: 0, qualificados: 0, pagos: 0 });
      res.json({ agora: new Date().toISOString(), mercado_ativo: process.env.MERCADO_ATIVO === 'on', funil: funil(conversas), conversas, campanha: { anuncios, total: tot, erro: m.erro || null, atualizado_em: new Date(cacheMeta.em).toISOString(), orcamento_dia: Number(process.env.CAMPANHA_ORCAMENTO_DIA || 100), entrada: Number(process.env.HONORARIOS_ENTRADA || 500) } });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  r.get('/api/conversas/:id', async (req, res) => {
    try {
      const s = db(); if (!s) return res.status(503).json({ erro: 'sem banco' });
      const { data: c } = await s.from('se_conversas').select('*').eq('id', req.params.id).maybeSingle();
      if (!c) return res.status(404).json({ erro: 'não achei' });
      const { data: msgs } = await s.from('se_mensagens').select('direcao,tipo,texto,criado_em').eq('conversa_id', c.id).order('criado_em', { ascending: true }).limit(300);
      const ids = (c.triagem?.assinaturas || []).map(a => a.autentiqueId).filter(Boolean);
      const ass = ids.length ? await statusAssinaturas(ids).catch(() => []) : [];
      const assinaturas = (c.triagem?.assinaturas || []).map(a => ({ nome: a.nome, link: a.link, status: ass.find(x => x.autentique_id === a.autentiqueId)?.status || 'pendente' }));
      let processo = null, distribuicao = null;
      if (c.processo_id) {
        const { data: p } = await s.from('processos').select('numero,status_processo,fase,tribunal,vara,comarca').eq('id', c.processo_id).maybeSingle(); processo = p;
        const { data: d } = await s.from('distribuicoes').select('id,status,valor_causa,created_at,entrevista_id,progresso,resultado,numero_processo').eq('processo_id', c.processo_id).order('created_at', { ascending: false }).limit(1).maybeSingle(); distribuicao = d;
      }
      const plano = projetarPlano(c.triagem || {});
      const checklist = checklistFechamento({ conversa: c, assinaturas, processo, distribuicao });
      const briefing = briefingFechamento({ conversa: c, plano, checklist });
      res.json({ ...resumirConversa(c), triagem: c.triagem, mensagens: msgs || [], assinaturas, cobranca: c.triagem?.cobranca || null, processo, distribuicao, plano, checklist, briefing });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  // Ações do operador: devolver à Paula (retomar), assumir (handoff: a Paula fica quieta) ou oferecer a advogados
  // (a Paula pede o consentimento da pessoa; com o SIM, a oferta abre sozinha).
  r.post('/api/conversas/:id/:acao', async (req, res) => {
    try {
      const { acao } = req.params;
      if (acao === 'retomar') await atualizarConversa(req.params.id, { etapa: 'retomar' });
      else if (acao === 'mensagem') {
        // Envia na hora como Paula; se o WhatsApp recusar (janela de 24 h fechada), deixa na fila do robô.
        const texto = String(req.body?.texto || '').trim();
        if (!texto) return res.status(400).json({ erro: 'texto vazio' });
        const s = db(); const { data: c } = await s.from('se_conversas').select('*').eq('id', req.params.id).maybeSingle();
        if (!c) return res.status(404).json({ erro: 'não achei' });
        try {
          const out = await sendText(c.wa_id, texto);
          await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: 'text', texto, waMessageId: out?.messages?.[0]?.id });
          return res.json({ ok: true, enviada: true });
        } catch (e) {
          await atualizarConversa(c.id, { triagem: { ...(c.triagem || {}), mensagem_operador: texto } });
          return res.json({ ok: true, enviada: false, motivo: e.message });
        }
      }
      else if (acao === 'assumir') await atualizarConversa(req.params.id, { etapa: 'handoff', handoff_em: new Date().toISOString(), handoff_motivo: 'assumido pelo painel' });
      else if (acao === 'oferecer') {
        const s = db(); const { data: c } = await s.from('se_conversas').select('*').eq('id', req.params.id).maybeSingle();
        if (!c) return res.status(404).json({ erro: 'não achei' });
        if (!ETAPAS_OFERTAVEIS.includes(c.etapa)) return res.status(400).json({ erro: `lead em "${c.etapa}" não pode ser oferecido (já assinou ou pagou com o escritório)` });
        if (c.consentimento_indicacao_em) { const o = await criarOferta(c.id, { criadoPor: 'painel' }); return res.json({ ok: true, oferta: o.id }); }
        const texto = MSG.pedirIndicacao(c.nome_perfil);
        const out = await sendText(c.wa_id, texto);
        await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: 'text', texto, waMessageId: out?.messages?.[0]?.id });
        await atualizarConversa(c.id, { etapa: 'consentimento_indicacao', etapa_anterior: c.etapa });
        return res.json({ ok: true, aguardando_consentimento: true });
      }
      else return res.status(400).json({ erro: 'ação desconhecida' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  // Mercado: ofertas e lances para o operador; cancelar ou reabrir.
  r.get('/api/ofertas', async (_req, res) => {
    try {
      const s = db(); if (!s) return res.status(503).json({ erro: 'sem banco' });
      const { data: ofertas } = await s.from('se_ofertas').select('*').order('criado_em', { ascending: false }).limit(100);
      const ids = (ofertas || []).map(o => o.id);
      const { data: lances } = ids.length ? await s.from('se_lances').select('oferta_id,advogado_id,valor,criado_em').in('oferta_id', ids).order('valor', { ascending: false }) : { data: [] };
      const { data: advs } = await s.from('se_advogados').select('id,nome,oab,uf,email,ativo,termo_aceito_em,criado_em').order('criado_em', { ascending: false });
      const nomeAdv = Object.fromEntries((advs || []).map(a => [a.id, `${a.nome} (OAB/${a.uf} ${a.oab})`]));
      const convIds = (ofertas || []).map(o => o.conversa_id);
      const { data: convs } = convIds.length ? await s.from('se_conversas').select('id,nome_perfil,wa_id,etapa').in('id', convIds) : { data: [] };
      const conv = Object.fromEntries((convs || []).map(c => [c.id, c]));
      res.json({
        advogados: advs || [],
        ofertas: (ofertas || []).map(o => ({ ...o, lead: conv[o.conversa_id] ? { nome: conv[o.conversa_id].nome_perfil, telefone: formatar(conv[o.conversa_id].wa_id), etapa: conv[o.conversa_id].etapa } : null, vencedor: o.vencedor_id ? nomeAdv[o.vencedor_id] : null, lances: (lances || []).filter(l => l.oferta_id === o.id).map(l => ({ valor: Number(l.valor), advogado: nomeAdv[l.advogado_id] || '?', em: l.criado_em })) })),
      });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  r.post('/api/ofertas/:id/:acao', async (req, res) => {
    try {
      const s = db(); const { acao } = req.params;
      const { data: o } = await s.from('se_ofertas').select('*').eq('id', req.params.id).maybeSingle();
      if (!o) return res.status(404).json({ erro: 'não achei' });
      if (acao === 'cancelar') { await s.from('se_ofertas').update({ status: 'cancelada', atualizado_em: new Date().toISOString() }).eq('id', o.id); const { data: c } = await s.from('se_conversas').select('etapa_anterior').eq('id', o.conversa_id).single(); await atualizarConversa(o.conversa_id, { etapa: c?.etapa_anterior || 'triagem', oferta_id: null }); }
      else if (acao === 'reabrir') { if (!['expirada', 'cancelada'].includes(o.status)) return res.status(400).json({ erro: 'só reabre expirada ou cancelada' }); const n = await criarOferta(o.conversa_id, { criadoPor: 'painel (reaberta)', precoMinimo: Number(req.body?.preco_minimo) || undefined }); return res.json({ ok: true, oferta: n.id }); }
      else return res.status(400).json({ erro: 'ação desconhecida' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });
  return r;
}
