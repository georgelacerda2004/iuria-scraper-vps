// Pós-contratação: avisa o número do processo quando o advogado protocola e cada andamento novo.
import { db, gravarMensagem, atualizarConversa } from './db.js';
import { enviar } from './whatsapp.js';
import { disponivel } from './templates.js';
import { linkConsulta, andamentosDesde } from './iuria.js';

const NOME_ROBO = () => process.env.NOME_ROBO || 'Paula';
const primeiro = (n) => (n || '').split(' ')[0];

async function mandar(c, { texto, template, params }, deps) {
  const r = await (deps.enviar || enviar)({ to: c.wa_id, texto, ultimaEntradaEm: c.ultima_entrada_em, template, params, templateDisponivel: deps.templateDisponivel || disponivel });
  if (!r) return false;
  await gravarMensagem({ conversaId: c.id, waId: c.wa_id, direcao: 'out', tipo: r.via === 'template' ? 'template' : 'text', texto: r.texto, waMessageId: r.out?.messages?.[0]?.id });
  return true;
}

export function textoProtocolo(c, p) {
  const nome = primeiro(c.nome_perfil);
  return `${nome ? nome + ', b' : 'B'}oa notícia: o advogado protocolou o seu processo. 🎉\n\nNúmero: *${p.numero}*\n${[p.tribunal, p.vara, p.comarca].filter(Boolean).join(' · ')}\n\nVocê pode acompanhar pelo site do tribunal: ${linkConsulta(p)}\n\nEu também te aviso por aqui a cada andamento importante. Qualquer dúvida, é só me chamar. Aqui é a ${NOME_ROBO()}.`;
}

export function textoAndamento(c, p, a) {
  const nome = primeiro(c.nome_perfil);
  return `${nome ? nome + ', n' : 'N'}ovidade no seu processo ${p.numero}:\n\n${a.data ? a.data + ' · ' : ''}${a.tipo ? a.tipo + ': ' : ''}${(a.descricao || '').slice(0, 400)}\n\nSe quiser, me pergunta que eu explico o que isso significa. Se for algo que precise de decisão, o advogado fala com você por aqui.`;
}

export async function rodar({ deps = {} } = {}) {
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
      if (!c.protocolo_avisado_em) {
        const ok = await mandar(c, { texto: textoProtocolo(c, p), template: 'se_processo_protocolado', params: [primeiro(c.nome_perfil) || 'tudo bem', p.numero, linkConsulta(p)] }, deps);
        if (ok) { const em = new Date().toISOString(); await atualizarConversa(c.id, { protocolo_avisado_em: em, andamento_avisado_em: em }); protocolos++; }
        continue; // andamentos a partir do próximo ciclo
      }
      const novos = await (deps.andamentos || andamentosDesde)(c.processo_id, c.andamento_avisado_em);
      for (const a of novos) {
        const ok = await mandar(c, { texto: textoAndamento(c, p, a), template: 'se_andamento', params: [primeiro(c.nome_perfil) || 'tudo bem', p.numero, `${a.tipo || 'andamento'}: ${(a.descricao || '').slice(0, 150)}`] }, deps);
        if (!ok) break;
        await atualizarConversa(c.id, { andamento_avisado_em: a.created_at }); andamentos++;
      }
    } catch (e) { console.error('[pos]', c.wa_id, e.message); }
  }
  return { protocolos, andamentos };
}
