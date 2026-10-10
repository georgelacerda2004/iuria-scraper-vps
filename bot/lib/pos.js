// Pós-contratação: avisa o número do processo quando o advogado protocola e cada andamento novo.
import { db, gravarMensagem, atualizarConversa } from './db.js';
import { enviar } from './whatsapp.js';
import { disponivel } from './templates.js';
import { linkConsulta, andamentosDesde, chaveConsulta, buscarCliente, linkPortal } from './iuria.js';
import { classificarAndamento, textoAndamentoExplicado, tratarLiminarDeferida, textoEntradaAposLiminar } from './andamentos.js';

const NOME_ROBO = () => process.env.NOME_ROBO || 'Paula';
const primeiro = (n) => (n || '').split(' ')[0];

async function mandar(c, { texto, template, params }, deps) {
  const r = await (deps.enviar || enviar)({ to: c.wa_id, texto, ultimaEntradaEm: c.ultima_entrada_em, template, params, templateDisponivel: deps.templateDisponivel || disponivel });
  if (!r) return false;
  await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: r.via === 'template' ? 'template' : 'text', texto: r.texto, waMessageId: r.out?.messages?.[0]?.id });
  return true;
}

export function textoProtocolo(c, p, chave, portal) {
  const nome = primeiro(c.nome_perfil);
  const consulta = chave ? `Para consultar no site do tribunal use o número do processo e a chave *${chave}*: ${linkConsulta(p, chave).split(' (')[0]}` : `Você pode acompanhar pelo site do tribunal: ${linkConsulta(p)}`;
  const acomp = portal ? `Acompanhe o andamento neste link (é só abrir, sem senha): ${portal}\n\n${consulta}` : consulta;
  return `${nome ? nome + ', b' : 'B'}oa notícia: o advogado protocolou o seu processo. 🎉\n\nNúmero: *${p.numero}*\n${[p.tribunal, p.vara, p.comarca].filter(Boolean).join(' · ')}\n\n${acomp}\n\nEu também te aviso por aqui a cada andamento importante e explico o que cada um significa. Qualquer dúvida, é só me chamar. Aqui é a ${NOME_ROBO()}.`;
}

export function textoAndamento(c, p, a) {
  const nome = primeiro(c.nome_perfil);
  return `${nome ? nome + ', n' : 'N'}ovidade no seu processo ${p.numero}:\n\n${a.data ? a.data + ' · ' : ''}${a.tipo ? a.tipo + ': ' : ''}${(a.descricao || '').slice(0, 400)}\n\nSe quiser, me pergunta que eu explico o que isso significa. Se for algo que precise de decisão, o advogado fala com você por aqui.`;
}

const dataBR = (iso) => !iso ? null : /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

// Memória do caso para a Paula falar como advogada: o que a cliente já fez, quando, e o que ainda falta.
export function linhaDoTempo(c, p) {
  const t = c.triagem || {};
  const l = [];
  if (c.criado_em) l.push(`${dataBR(c.criado_em)}: primeiro contato pelo anúncio`);
  if (t.registrado_em) l.push(`${dataBR(t.registrado_em)}: análise do caso concluída (favorável)`);
  if (t.proposta_aceita_em) l.push(`${dataBR(t.proposta_aceita_em)}: contratou o escritório (${t.pagamento === 'apos_liminar' ? 'entrada após a liminar' : t.pagamento === 'ad_exitum' ? 'sem entrada, só êxito' : 'entrada paga'})`);
  const docs = Object.keys(t.documentos || {}).filter(k => !k.endsWith('_pendentes') && k !== 'dividas');
  if (docs.length) l.push(`documentos pessoais enviados: ${docs.join(', ')}${t.docs_dividas ? `; ${t.docs_dividas} extrato(s)/contrato(s) de dívida` : ''}`);
  if (c.assinado_em) l.push(`${dataBR(c.assinado_em)}: assinou procuração, contrato e declaração`);
  if (p?.data_distribuicao || c.protocolo_avisado_em) l.push(`${dataBR(p?.data_distribuicao || c.protocolo_avisado_em)}: processo protocolado${p?.numero ? ' (' + p.numero + ')' : ''}`);
  if (t.liminar_deferida_em) l.push(`${dataBR(t.liminar_deferida_em)}: liminar concedida`);
  const pend = docsPendentes(c);
  return `LINHA DO TEMPO DA CLIENTE:\n- ${l.join('\n- ')}\nDOCUMENTOS/INFORMAÇÕES PENDENTES: ${pend || 'nenhum'}`;
}

// Texto livre gravado pelo advogado/painel (triagem.docs_pendentes) com o que ainda falta a cliente mandar.
export function docsPendentes(c) {
  const t = c?.triagem || {};
  if (t.docs_pendentes_resolvido_em) return '';
  return String(t.docs_pendentes || '').trim();
}

export function textoDocsPendentes(c, pend) {
  const nome = primeiro(c.nome_perfil);
  return `${nome ? nome + ', u' : 'U'}ma coisa importante: o processo já foi distribuído, mas para o advogado conferir tudo e você não ter prejuízo, ainda falta você me mandar ${pend}.\n\nPode mandar foto ou PDF por aqui mesmo que eu guardo na sua pasta e o advogado complementa o processo. Qualquer dúvida sobre o que é, me pergunta.`;
}

// `andamentos: false` só avisa protocolos novos (roda a cada 15 min). A leitura de andamentos (e a liminar) roda
// uma vez por dia, no horário do escritório, com `andamentos: true`.
export async function rodar({ deps = {}, andamentos: lerAndamentos = true } = {}) {
  const s = db();
  if (!s) return { protocolos: 0, andamentos: 0 };
  const { data: convs } = await s.from('se_conversas').select('*').eq('etapa', 'cliente').not('processo_id', 'is', null).limit(100);
  if (!convs?.length) return { protocolos: 0, andamentos: 0 };
  const { data: procs } = await s.from('processos').select('id,numero,tribunal,vara,comarca,status_processo').in('id', convs.map(c => c.processo_id));
  const porId = Object.fromEntries((procs || []).map(p => [p.id, p]));
  let protocolos = 0, andamentos = 0;
  for (const c of convs) {
    const p = porId[c.processo_id];
    if (!p?.numero) continue;
    try {
      const chave = await (deps.chave || chaveConsulta)(c.processo_id);
      const portal = await (deps.portal || linkPortal)(c.cliente_id);
      if (!c.protocolo_avisado_em) {
        const ok = await mandar(c, { texto: textoProtocolo(c, p, chave, portal), template: 'se_processo_protocolado', params: [primeiro(c.nome_perfil) || 'tudo bem', p.numero, portal || linkConsulta(p, chave).split(' (')[0]] }, deps);
        if (ok) { const em = new Date().toISOString(); await atualizarConversa(c.id, { protocolo_avisado_em: em, andamento_avisado_em: em }); protocolos++; }
        const pend = docsPendentes(c);
        if (ok && pend) await mandar(c, { texto: textoDocsPendentes(c, pend), template: 'se_pendencia', params: [primeiro(c.nome_perfil) || 'tudo bem', pend.slice(0, 200), 'por aqui mesmo'] }, deps);
        continue; // andamentos a partir do próximo ciclo
      }
      if (!lerAndamentos) continue;
      const novos = await (deps.andamentos || andamentosDesde)(c.processo_id, c.andamento_avisado_em);
      for (const a of novos) {
        // A Paula lê a movimentação e explica; liminar deferida dispara a entrada (se for "após a liminar") e o êxito.
        const classe = await classificarAndamento(a, { contexto: `${c.triagem?.resumo || ''}`.slice(0, 800), deps });
        const link = portal || linkConsulta(p, chave).split(' (')[0];
        const texto = textoAndamentoExplicado({ nome: c.nome_perfil, processo: p, andamento: a, classe, link });
        const ok = await mandar(c, { texto, template: 'se_andamento', params: [primeiro(c.nome_perfil) || 'tudo bem', p.numero, `${a.tipo || 'andamento'}: ${(classe.resumo_cliente || a.descricao || '').slice(0, 150)}`] }, deps);
        if (!ok) break;
        await atualizarConversa(c.id, { andamento_avisado_em: a.created_at }); andamentos++;
        if (classe.categoria === 'liminar_deferida') {
          const cliente = await (deps.cliente || buscarCliente)(c.cliente_id);
          const r = await (deps.tratarLiminar || tratarLiminarDeferida)({ conversa: c, cliente, processo: p, andamento: a, deps });
          if (r?.patch?.cobranca?.url) await mandar(c, { texto: textoEntradaAposLiminar({ nome: c.nome_perfil, cobranca: r.patch.cobranca }), template: 'se_pendencia', params: [primeiro(c.nome_perfil) || 'tudo bem', 'entrada após a liminar', r.patch.cobranca.url] }, deps);
          c.triagem = { ...(c.triagem || {}), ...(r?.patch || {}) };
        }
      }
    } catch (e) { console.error('[pos]', c.wa_id, e.message); }
  }
  return { protocolos, andamentos };
}
