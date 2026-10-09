// Pacote de protocolo: petição em PDF (a partir do HTML gerado) + cada anexo como PDF (imagens convertidas),
// tudo no bucket "documentos" em se-uploads/<cliente>/protocolo/. É o que o robô do PC vai subir no e-SAJ.
import PDFDocument from 'pdfkit';
import { db } from './db.js';

const BUCKET = 'documentos';
const CM = 28.35; // pontos por centímetro

const ENT = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&ordm;': 'º', '&ordf;': 'ª', '&sect;': '§', '&mdash;': '—', '&ndash;': '–' };
const limpar = s => String(s || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, c) => ENT[m] ?? (c[0] === '#' ? String.fromCodePoint(c[1] === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10)) : m))
  .replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();

// Quebra o HTML da petição (estrutura fixa do gerar-inicial) em blocos tipados.
export function extrairBlocos(html) {
  // Remove divs vazias aninhadas (ex.: a linha da assinatura), que quebrariam a leitura não-gulosa do bloco pai.
  const corpo = (String(html || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, String(html || '')])[1].replace(/<div[^>]*>\s*<\/div>/gi, '');
  const blocos = [];
  const re = /<(div|p|li|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(corpo))) {
    const tag = m[1].toLowerCase(), attrs = m[2], texto = limpar(m[3]);
    if (!texto) continue;
    const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];
    let tipo = 'p';
    if (tag === 'li') tipo = 'li';
    else if (/enderecamento/.test(cls)) tipo = 'enderecamento';
    else if (/titulo-acao/.test(cls)) tipo = 'titulo';
    else if (/secao/.test(cls) || /^h[1-6]$/.test(tag)) tipo = 'secao';
    else if (/fechamento/.test(cls)) tipo = 'fechamento';
    else if (/assinatura/.test(cls)) tipo = 'assinatura';
    blocos.push({ tipo, texto });
  }
  return blocos;
}

// HTML da petição -> PDF A4 (Times 12, margens 3/2,5/2/3 cm, parágrafo com recuo, pedidos em alíneas).
export async function htmlParaPdf(html) {
  const blocos = extrairBlocos(html);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 3 * CM, right: 2.5 * CM, bottom: 2 * CM, left: 3 * CM }, info: { Title: 'Petição inicial' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));
  const larg = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Times-Roman').fontSize(12);
  let alinea = 0, fechou = false;
  for (const b of blocos) {
    if (b.tipo === 'enderecamento') { doc.font('Times-Bold').text(b.texto.toUpperCase(), { align: 'center', lineGap: 4 }).font('Times-Roman'); doc.moveDown(6); }
    else if (b.tipo === 'titulo') { doc.moveDown(1).font('Times-Bold').fontSize(13).text(b.texto.toUpperCase(), { align: 'center', lineGap: 4 }).fontSize(12).font('Times-Roman'); doc.moveDown(1); alinea = 0; }
    else if (b.tipo === 'secao') { doc.moveDown(0.8).font('Times-Bold').text(b.texto.toUpperCase(), { align: 'left', lineGap: 4 }).font('Times-Roman'); doc.moveDown(0.3); alinea = 0; }
    else if (b.tipo === 'li') { const letra = String.fromCharCode(97 + (alinea++ % 26)) + ') '; doc.text(letra + b.texto, { align: 'justify', indent: 1.5 * CM, lineGap: 4, width: larg }); doc.moveDown(0.3); }
    else if (b.tipo === 'fechamento') {
      // Fecho + data + assinatura ficam juntos: se não cabem (~6 cm), vão para a página seguinte.
      if (!fechou && doc.y > doc.page.height - doc.page.margins.bottom - 6 * CM) doc.addPage();
      fechou = true;
      doc.moveDown(1).text(b.texto, { align: 'center', lineGap: 4 });
    }
    else if (b.tipo === 'assinatura') {
      doc.moveDown(2);
      const x = doc.page.margins.left + (larg - 8 * CM) / 2;
      doc.moveTo(x, doc.y).lineTo(x + 8 * CM, doc.y).stroke();
      doc.moveDown(0.3).text(b.texto, { align: 'center', lineGap: 4 });
    }
    else { doc.text(b.texto, { align: 'justify', indent: 2 * CM, lineGap: 4, width: larg }); doc.moveDown(0.4); }
  }
  doc.end();
  return done;
}

// Imagem (JPEG/PNG) -> PDF de uma página, ajustada à área útil. WebP não é suportado pelo pdfkit.
export async function imagemParaPdf(buffer, mime) {
  if (!/^image\/(jpe?g|png)$/i.test(mime || '')) throw new Error(`imagem ${mime} não conversível (só JPEG/PNG)`);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 1.5 * CM, right: 1.5 * CM, bottom: 1.5 * CM, left: 1.5 * CM } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));
  const w = doc.page.width - 3 * CM, h = doc.page.height - 3 * CM;
  doc.image(buffer, 1.5 * CM, 1.5 * CM, { fit: [w, h], align: 'center', valign: 'center' });
  doc.end();
  return done;
}

const slug = s => String(s || 'documento').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60);
const num = i => String(i).padStart(2, '0');

// Monta o pacote de uma distribuição: devolve a lista de PDFs (ordem, nome, tipo, storage_path) e os avisos.
// deps: { baixar(path)->Buffer, subir(path, buffer), peticaoHtml }
export async function montarPacote({ distribuicao, clienteId, peticaoHtml, deps = {} }) {
  const s = db();
  const baixar = deps.baixar || (async p => { const { data, error } = await s.storage.from(BUCKET).download(p); if (error || !data) throw new Error(`download ${p}: ${error?.message || 'vazio'}`); return Buffer.from(await data.arrayBuffer()); });
  const subir = deps.subir || (async (p, buf) => { const { error } = await s.storage.from(BUCKET).upload(p, buf, { contentType: 'application/pdf', upsert: true }); if (error) throw new Error(`upload ${p}: ${error.message}`); return p; });
  const base = `se-uploads/${clienteId}/protocolo/${distribuicao.id.slice(0, 8)}`;
  const pacote = [], avisos = [];
  if (!peticaoHtml) throw new Error('petição ainda não gerada');
  const pdf = await htmlParaPdf(peticaoHtml);
  pacote.push({ ordem: 1, nome: '01-peticao-inicial.pdf', tipo: 'Petição inicial', storage_path: await subir(`${base}/01-peticao-inicial.pdf`, pdf), bytes: pdf.length, origem: 'gerado' });
  let i = 2;
  for (const a of distribuicao.anexos || []) {
    if (!a?.storage_path) continue;
    const nome = `${num(i)}-${slug(a.nome || a.tipo)}.pdf`;
    try {
      const mime = String(a.mime_type || '').toLowerCase();
      if (mime === 'application/pdf' || /\.pdf$/i.test(a.storage_path)) {
        pacote.push({ ordem: i, nome, tipo: a.tipo || 'Outro', storage_path: a.storage_path, origem: 'original' });
      } else if (/^image\//.test(mime)) {
        const buf = await baixar(a.storage_path);
        const conv = await imagemParaPdf(buf, mime);
        pacote.push({ ordem: i, nome, tipo: a.tipo || 'Outro', storage_path: await subir(`${base}/${nome}`, conv), bytes: conv.length, origem: 'convertido' });
      } else { avisos.push(`${a.nome || a.storage_path}: tipo ${mime || 'desconhecido'} não convertido`); continue; }
      i++;
    } catch (e) { avisos.push(`${a.nome || a.storage_path}: ${e.message}`); }
  }
  return { pacote, avisos };
}
