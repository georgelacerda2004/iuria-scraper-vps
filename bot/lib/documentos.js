// PDFs do caso: procuração, contrato de honorários e declaração de superendividamento.
// Modelos próprios do fluxo (os do JurosZero têm advogado/réu fixos). Dados do advogado vêm do ambiente.
import PDFDocument from 'pdfkit';

const ADV = () => ({
  nome: process.env.ADVOGADO_NOME || '[NOME DO ADVOGADO]',
  oab: process.env.ADVOGADO_OAB || '[OAB/UF nº 000.000]',
  nacionalidade: process.env.ADVOGADO_NACIONALIDADE || 'brasileiro',
  escritorio: process.env.NOME_ESCRITORIO || 'o escritório',
  endereco: process.env.ESCRITORIO_ENDERECO || '',
  foro: process.env.FORO_CONTRATO || 'São Paulo/SP',
});
const ENTRADA = () => Number(process.env.HONORARIOS_ENTRADA || 500);
const EXITO_PCT = () => Number(process.env.HONORARIOS_EXITO_PCT || 30);
const porExtenso = (n) => ({ 10: 'dez', 15: 'quinze', 20: 'vinte', 25: 'vinte e cinco', 30: 'trinta', 35: 'trinta e cinco', 40: 'quarenta' }[n] || String(n));
const RESTANTE = () => process.env.HONORARIOS_RESTANTE_TEXTO || `honorários de êxito de ${EXITO_PCT()}% (${porExtenso(EXITO_PCT())} por cento) sobre o proveito econômico efetivamente obtido pelo(a) CONTRATANTE (redução do valor das parcelas, dos juros ou do saldo das dívidas, apurada pela diferença entre o que era exigido e o que ficou definido em acordo ou decisão), devidos somente ao final do processo e somente em caso de resultado favorável`;

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function dataExtenso(d = new Date()) { return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`; }
function brl(n) { return 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

function qualificacao(c) {
  const p = [c.nome || '[NOME]', (c.nacionalidade || 'brasileiro(a)').toLowerCase()];
  if (c.estado_civil) p.push(String(c.estado_civil).toLowerCase());
  if (c.profissao) p.push(String(c.profissao).toLowerCase());
  let q = p.join(', ');
  if (c.rg) q += `, portador(a) do RG nº ${c.rg}`;
  if (c.cpf) q += `, inscrito(a) no CPF sob o nº ${c.cpf}`;
  const end = [c.endereco, c.bairro && `bairro ${c.bairro}`, c.cidade && `${c.cidade}${c.uf ? '/' + c.uf : ''}`, c.cep && `CEP ${c.cep}`].filter(Boolean);
  if (end.length) q += `, residente e domiciliado(a) na ${end.join(', ')}`;
  return q;
}

function novoDoc() {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 70, bottom: 70, left: 60, right: 60 } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise(res => doc.on('end', () => res(Buffer.concat(chunks))));
  doc.font('Times-Roman').fontSize(12);
  return { doc, done };
}
function titulo(doc, t) { doc.font('Times-Bold').fontSize(16).text(t.toUpperCase(), { align: 'center' }).moveDown(1.2).font('Times-Roman').fontSize(12); }
function sub(doc, t) { doc.moveDown(0.4).font('Times-Bold').text(t.toUpperCase()).font('Times-Roman').moveDown(0.2); }
function par(doc, t) { doc.text(t, { align: 'justify', lineGap: 3 }).moveDown(0.6); }
function assinatura(doc, nome, info) {
  doc.moveDown(2.5);
  const x = doc.page.margins.left + 60, w = doc.page.width - doc.page.margins.left - doc.page.margins.right - 120;
  doc.moveTo(x, doc.y).lineTo(x + w, doc.y).stroke();
  doc.moveDown(0.3).font('Times-Bold').text((nome || '').toUpperCase(), { align: 'center' }).font('Times-Roman');
  if (info) doc.fontSize(10).text(info, { align: 'center' }).fontSize(12);
}
function localData(doc, c) { doc.moveDown(1).text(`${c.cidade ? `${c.cidade}${c.uf ? '/' + c.uf : ''}` : ADV().foro}, ${dataExtenso()}.`, { align: 'center' }); }

export async function gerarProcuracao(c) {
  const a = ADV(); const { doc, done } = novoDoc();
  titulo(doc, 'Procuração');
  sub(doc, 'Outorgante'); par(doc, qualificacao(c) + '.');
  sub(doc, 'Outorgado'); par(doc, `${a.nome}, ${a.nacionalidade}, advogado(a), inscrito(a) na ${a.oab}${a.endereco ? `, com escritório na ${a.endereco}` : ''}.`);
  sub(doc, 'Poderes');
  par(doc, 'Pelo presente instrumento particular, o(a) Outorgante nomeia e constitui o(a) Outorgado(a) seu(sua) bastante procurador(a), conferindo-lhe os poderes da cláusula ad judicia et extra, em qualquer juízo, instância ou tribunal, para propor e acompanhar o processo de repactuação de dívidas previsto nos arts. 104-A a 104-C do Código de Defesa do Consumidor (Lei 14.181/2021), inclusive na fase de conciliação pré-processual, bem como as ações e incidentes dela decorrentes, podendo receber citação, confessar, reconhecer a procedência do pedido, transigir, desistir, renunciar ao direito sobre que se funda a ação, receber e dar quitação, firmar compromissos e acordos com credores, requerer os benefícios da justiça gratuita, levantar valores, substabelecer com ou sem reserva de poderes, e praticar todos os demais atos necessários ao fiel cumprimento deste mandato.');
  localData(doc, c); assinatura(doc, c.nome, c.cpf ? `CPF nº ${c.cpf}` : '');
  doc.end(); return done;
}

export async function gerarContrato(c, triagem = {}) {
  const diferido = triagem.pagamento === 'apos_liminar';
  const adExitum = triagem.pagamento === 'ad_exitum';
  const ADEX = Number(process.env.HONORARIOS_ADEXITUM_PCT || EXITO_PCT());
  const a = ADV(); const { doc, done } = novoDoc();
  titulo(doc, 'Contrato de Prestação de Serviços Advocatícios');
  sub(doc, 'Contratante'); par(doc, qualificacao(c) + '.');
  sub(doc, 'Contratado(a)'); par(doc, `${a.nome}, ${a.nacionalidade}, advogado(a), inscrito(a) na ${a.oab}${a.endereco ? `, com escritório na ${a.endereco}` : ''}.`);
  par(doc, 'As partes têm entre si justo e contratado o presente contrato de honorários advocatícios, nos termos do art. 22 da Lei 8.906/1994 e do Código de Ética e Disciplina da OAB, mediante as cláusulas seguintes:');
  sub(doc, 'Cláusula 1ª — Objeto');
  par(doc, 'O(A) CONTRATADO(A) prestará ao(à) CONTRATANTE os serviços de análise jurídica da situação de superendividamento, elaboração do plano de pagamento e propositura e acompanhamento do processo de repactuação de dívidas previsto nos arts. 104-A a 104-C do Código de Defesa do Consumidor (Lei 14.181/2021), incluída a fase de conciliação, e, se necessário, o pedido de plano judicial compulsório, até decisão final em primeira instância.');
  sub(doc, 'Cláusula 2ª — Honorários');
  par(doc, adExitum
    ? `Pelos serviços, considerando a situação financeira declarada, as partes ajustam que não haverá entrada nem qualquer pagamento antecipado. O(A) CONTRATANTE pagará ao(à) CONTRATADO(A) exclusivamente honorários de êxito (ad exitum) de ${ADEX}% (${porExtenso(ADEX)} por cento) sobre o proveito econômico efetivamente obtido (redução do valor das parcelas, dos juros ou do saldo das dívidas, apurada pela diferença entre o que era exigido e o que ficou definido em acordo ou decisão), devidos somente ao final do processo e somente em caso de resultado favorável. Não havendo proveito econômico, nada será devido a título de honorários contratuais.`
    : diferido
    ? `Pelos serviços, o(a) CONTRATANTE pagará ao(à) CONTRATADO(A), a título de entrada, o valor de ${brl(ENTRADA())}. Considerando a situação financeira declarada, as partes ajustam que a entrada será devida em até 10 (dez) dias após a intimação da decisão que deferir, ainda que em parte, a tutela de urgência (liminar) requerida na ação; não sendo deferida, as partes ajustarão por escrito nova data, sem prejuízo da continuidade dos serviços. Quanto ao restante: ${RESTANTE()}.`
    : `Pelos serviços, o(a) CONTRATANTE pagará ao(à) CONTRATADO(A), a título de entrada, o valor de ${brl(ENTRADA())}, por meio de cobrança eletrônica, no ato da contratação. Quanto ao restante: ${RESTANTE()}.`);
  par(doc, 'Os honorários de sucumbência eventualmente fixados pertencem ao(à) CONTRATADO(A), nos termos do art. 23 da Lei 8.906/1994, sem compensação com os honorários contratuais.');
  sub(doc, 'Cláusula 3ª — Sem promessa de resultado');
  par(doc, 'O(A) CONTRATANTE declara estar ciente de que a obrigação do(a) CONTRATADO(A) é de meio, e não de resultado: a redução, o parcelamento ou a limitação de descontos dependem de decisão judicial e da conciliação com os credores, não havendo garantia de percentual, prazo ou êxito.');
  sub(doc, 'Cláusula 4ª — Deveres do(a) contratante');
  par(doc, 'O(A) CONTRATANTE compromete-se a fornecer, com veracidade, a relação completa de credores, contratos, extratos, comprovantes de renda e despesas, e a comparecer às audiências designadas. A omissão de dívida ou a prestação de informação falsa pode prejudicar o pedido e autoriza a rescisão deste contrato.');
  sub(doc, 'Cláusula 5ª — Despesas');
  par(doc, 'As custas e despesas processuais correrão por conta do(a) CONTRATANTE, salvo concessão da justiça gratuita, que será requerida.');
  sub(doc, 'Cláusula 6ª — Atendimento por assistente virtual e proteção de dados');
  par(doc, 'O(A) CONTRATANTE está ciente de que parte do atendimento inicial foi realizada por assistente virtual com inteligência artificial, sob supervisão do(a) CONTRATADO(A), e autoriza o tratamento dos seus dados pessoais e documentos exclusivamente para a finalidade deste contrato, nos termos da Lei 13.709/2018 (LGPD).');
  sub(doc, 'Cláusula 7ª — Rescisão');
  par(doc, 'Em caso de revogação do mandato sem justa causa após o ajuizamento, serão devidos os honorários proporcionais ao trabalho realizado, não se restituindo a entrada.');
  sub(doc, 'Cláusula 8ª — Foro');
  par(doc, `Fica eleito o foro de ${a.foro} para dirimir questões oriundas deste contrato.`);
  localData(doc, c); assinatura(doc, c.nome, 'CONTRATANTE'); assinatura(doc, a.nome, `CONTRATADO(A) · ${a.oab}`);
  doc.end(); return done;
}

// Declaração do consumidor com a relação de credores e a situação financeira (anexo da inicial).
export async function gerarDeclaracao(c, triagem = {}) {
  const { doc, done } = novoDoc();
  const calc = triagem.calculo || {};
  const dividas = triagem.dividas || [];
  titulo(doc, 'Declaração de Superendividamento');
  par(doc, `Eu, ${qualificacao(c)}, DECLARO, sob as penas da lei, para os fins dos arts. 54-A e 104-A do Código de Defesa do Consumidor (Lei 14.181/2021), que me encontro em situação de superendividamento, assim entendida a impossibilidade manifesta de pagar a totalidade das minhas dívidas de consumo, exigíveis e vincendas, sem comprometer o meu mínimo existencial, e que contraí essas dívidas de boa-fé.`);
  sub(doc, 'Renda e despesas');
  par(doc, `Renda líquida mensal declarada: ${brl(calc.renda_liquida)}. Parcelas mensais de dívidas de consumo: ${brl(calc.parcelas_mensais_consideradas)} (${calc.percentual_renda_comprometido ?? '-'}% da renda). Fonte de renda: ${triagem.fonte_renda || 'não informada'}.`);
  sub(doc, 'Relação de credores');
  if (dividas.length) {
    for (const d of dividas) par(doc, `• ${d.credor || 'Credor não identificado'} — ${d.tipo || 'dívida'}: parcela mensal ${brl(d.parcela_mensal)}; saldo aproximado ${brl(d.saldo_total)}.`);
  } else par(doc, 'Relação a ser complementada com os extratos e contratos apresentados ao advogado.');
  sub(doc, 'Compromisso');
  par(doc, 'Declaro que as informações acima são verdadeiras e que apresentarei os documentos comprobatórios (contratos, extratos e comprovantes de renda) para instruir o pedido de repactuação, estando ciente de que a falsidade desta declaração sujeita-me às sanções do art. 299 do Código Penal.');
  localData(doc, c); assinatura(doc, c.nome, c.cpf ? `CPF nº ${c.cpf}` : '');
  doc.end(); return done;
}

export async function gerarTodos(cliente, triagem) {
  const [procuracao, contrato, declaracao] = await Promise.all([gerarProcuracao(cliente), gerarContrato(cliente, triagem), gerarDeclaracao(cliente, triagem)]);
  return [
    { tipo: 'se_procuracao', nome: 'Procuração - Superendividamento', pdf: procuracao },
    { tipo: 'se_contrato', nome: 'Contrato de Honorários - Superendividamento', pdf: contrato },
    { tipo: 'se_declaracao', nome: 'Declaração de Superendividamento', pdf: declaracao },
  ];
}
