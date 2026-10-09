// Correções pontuais aplicadas no boot (idempotentes): trocas de texto em petições já geradas e ajustes em
// distribuições (valor da causa, polo passivo). Cada arquivo em correcoes/*.json é aplicado uma vez por boot;
// uma troca cujo texto antigo não existe mais é ignorada, então reaplicar não muda nada.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

export function lerCorrecoes(dir = path.join(AQUI, '..', 'correcoes')) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({ arquivo: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

export function aplicarTrocas(html, trocas) {
  let out = String(html || ''); let n = 0;
  for (const [de, para] of trocas || []) if (de && out.includes(de)) { out = out.split(de).join(para); n++; }
  return { html: out, trocas: n };
}

export async function aplicarCorrecoes({ s = db(), correcoes = lerCorrecoes() } = {}) {
  if (!s) return [];
  const feitas = [];
  for (const c of correcoes) {
    for (const p of c.peticoes || []) {
      const { data } = await s.from('inicial_entrevistas').select('peticao_html').eq('id', p.entrevista_id).maybeSingle();
      if (!data?.peticao_html) continue;
      const r = aplicarTrocas(data.peticao_html, p.trocas);
      if (!r.trocas) continue;
      const { error } = await s.from('inicial_entrevistas').update({ peticao_html: r.html }).eq('id', p.entrevista_id);
      if (error) console.error('[correcoes] petição', p.entrevista_id, error.message); else feitas.push(`petição ${p.entrevista_id.slice(0, 8)}: ${r.trocas} troca(s)`);
    }
    for (const d of c.distribuicoes || []) {
      const { data } = await s.from('distribuicoes').select('partes,valor_causa').eq('id', d.id).maybeSingle();
      if (!data) continue;
      const jaFeita = Number(data.valor_causa) === Number(d.valor_causa) && JSON.stringify(data.partes?.passivo) === JSON.stringify(d.passivo);
      if (jaFeita) continue;
      const patch = { valor_causa: d.valor_causa, partes: { ...(data.partes || {}), passivo: d.passivo } };
      const { error } = await s.from('distribuicoes').update(patch).eq('id', d.id);
      if (error) console.error('[correcoes] distribuição', d.id, error.message); else feitas.push(`distribuição ${d.id.slice(0, 8)}: valor ${d.valor_causa}, ${d.passivo.length} réu(s)`);
    }
    for (const m of c.mensagens || []) {
      const { data } = await s.from('se_conversas').select('triagem').eq('id', m.conversa_id).maybeSingle();
      if (!data || data.triagem?.['correcao_' + m.chave]) continue;
      const { error } = await s.from('se_conversas').update({ triagem: { ...(data.triagem || {}), mensagem_operador: m.texto, ['correcao_' + m.chave]: new Date().toISOString() } }).eq('id', m.conversa_id);
      if (error) console.error('[correcoes] mensagem', m.chave, error.message); else feitas.push(`mensagem ${m.chave} na fila`);
    }
  }
  if (feitas.length) console.log('[correcoes] aplicadas:', feitas.join(' | '));
  return feitas;
}
