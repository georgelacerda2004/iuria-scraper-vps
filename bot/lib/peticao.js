// Petição de repactuação (art. 104-A CDC) pela edge gerar-inicial do IURIA + rascunho em `distribuicoes`.
// Regra da casa: o robô NUNCA protocola. Ele deixa a entrevista "gerada" e a distribuição em
// 'rascunho' com tudo preenchido; o George revisa, completa CNPJ dos credores e assina com o A3.
import { db } from './db.js';

const SB_URL = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_SVC = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dataExtenso = (d = new Date()) => `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
const brl = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Texto da entrevista que a IA usa para redigir. Tudo vem da triagem e do cadastro; nada inventado.
export function montarEntrevista({ cliente, triagem, historicoTexto = '' }) {
  const c = triagem?.calculo || {};
  const dividas = triagem?.dividas || [];
  const linhas = [
    `AUTOR(A): ${cliente.nome}, ${cliente.nacionalidade || 'brasileiro(a)'}${cliente.estado_civil ? ', ' + cliente.estado_civil : ''}${cliente.profissao ? ', ' + cliente.profissao : ''}, RG ${cliente.rg || '-'}, CPF ${cliente.cpf || '-'}, residente em ${[cliente.endereco, cliente.bairro, cliente.cidade && `${cliente.cidade}${cliente.uf ? '/' + cliente.uf : ''}`, cliente.cep && `CEP ${cliente.cep}`].filter(Boolean).join(', ') || 'endereço a confirmar'}.`,
    `RÉUS: os credores abaixo (pessoas jurídicas; qualificação completa e CNPJ a serem conferidos pelo advogado antes do protocolo).`,
    `TIPO DE AÇÃO: Processo de repactuação de dívidas — superendividamento (arts. 54-A e 104-A a 104-C do CDC, Lei 14.181/2021). Rito: audiência global de conciliação com todos os credores; subsidiariamente, plano judicial compulsório (art. 104-B).`,
    `COMPETÊNCIA: Vara Cível do foro do domicílio do consumidor (${cliente.cidade || 'comarca a confirmar'}${cliente.uf ? '/' + cliente.uf : ''}). Não cabe no Juizado Especial (rito incompatível).`,
    `RENDA LÍQUIDA MENSAL: ${brl(c.renda_liquida)}. Fonte: ${triagem?.fonte_renda || 'não informada'}.`,
    `PARCELAS MENSAIS DE DÍVIDAS DE CONSUMO: ${brl(c.parcelas_mensais_consideradas)} (${c.percentual_renda_comprometido ?? '-'}% da renda). SOBRA MENSAL após dívidas e despesas essenciais: ${brl(c.sobra_mensal)}. MÍNIMO EXISTENCIAL (Decreto 11.567/2023): R$ 600,00.`,
    `RELAÇÃO DE CREDORES E DÍVIDAS:`,
    ...dividas.map((d, i) => `  ${i + 1}. ${d.credor || 'credor não identificado'} — ${d.tipo || 'dívida de consumo'}; parcela mensal ${brl(d.parcela_mensal)}; saldo aproximado ${brl(d.saldo_total)}.`),
    `SALDO TOTAL APROXIMADO: ${brl(c.saldo_total_considerado)} (valor da causa sugerido).`,
    `BOA-FÉ: ${triagem?.boa_fe === false ? 'NÃO confirmada na triagem — advogado deve apurar.' : 'consumidor declara ter contraído as dívidas de boa-fé, sem intenção de inadimplir.'} Pessoa física: ${triagem?.pessoa_fisica === false ? 'NÃO (atenção)' : 'sim'}.`,
    `EXCLUSÕES (art. 54-A §3º e Decreto 11.150/2022): ${(c.credores_excluidos || []).length ? 'há dívidas fora do regime (' + c.credores_excluidos.join(', ') + '), que NÃO entram no plano.' : 'nenhuma dívida excluída identificada.'}`,
    `PEDIDOS: (a) instauração do processo de repactuação com designação de audiência global de conciliação (art. 104-A); (b) apresentação do plano de pagamento em até 5 anos, preservado o mínimo existencial; (c) tutela de urgência para limitar os descontos/cobranças das dívidas de consumo ao percentual da renda que preserve o mínimo existencial e para suspender a exigibilidade até a audiência (art. 104-A §2º); (d) intimação dos credores para apresentar plano de pagamento sob as sanções do art. 104-A §2º; (e) subsidiariamente, instauração do plano judicial compulsório (art. 104-B); (f) justiça gratuita; (g) inversão do ônus da prova (art. 6º, VIII, CDC).`,
    `DOCUMENTOS JUNTADOS: documento de identidade, comprovante de endereço, comprovante de renda, declaração de superendividamento assinada, declaração de hipossuficiência assinada, procuração. Extratos e contratos das dívidas: ${triagem?.docs_dividas ? `${triagem.docs_dividas} arquivo(s) juntado(s)` : 'a complementar pelo advogado antes do protocolo'}.`,
    triagem?.resumo ? `RESUMO DA TRIAGEM DO ROBÔ: ${triagem.resumo}` : '',
    historicoTexto ? `TRECHOS DA CONVERSA (contexto fático): ${historicoTexto.slice(0, 4000)}` : '',
  ];
  return linhas.filter(Boolean).join('\n');
}

export async function gerarPeticao({ cliente, triagem, entrevistaId, anexos = [], historicoTexto = '', modelo }) {
  const advogado = process.env.ADVOGADO_NOME && process.env.ADVOGADO_OAB ? `${process.env.ADVOGADO_NOME} — ${process.env.ADVOGADO_OAB}` : undefined;
  const cidade = cliente.cidade ? `${cliente.cidade}${cliente.uf ? '/' + cliente.uf : ''}` : (process.env.FORO_CONTRATO || 'São Paulo/SP');
  const payload = {
    tipo_acao: 'Repactuação de dívidas — superendividamento (art. 104-A CDC)',
    entrevista: montarEntrevista({ cliente, triagem, historicoTexto }),
    entrevista_id: entrevistaId,
    advogado_signatario: advogado,
    cidade, data_protocolo: `${cidade}, ${dataExtenso()}`,
    anexos: anexos.slice(0, 5),
    modelo_ia: modelo || process.env.PETICAO_MODELO || 'opus',
  };
  const r = await fetch(`${SB_URL()}/functions/v1/gerar-inicial`, {
    method: 'POST', headers: { Authorization: `Bearer ${SB_SVC()}`, apikey: SB_SVC(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(200_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    // O gateway corta em 150 s, mas a edge continua e grava a peça em inicial_entrevistas: espera por ela.
    if (r.status === 504 || r.status === 502 || r.status === 524) {
      const pronta = await esperarPecaGerada(entrevistaId);
      if (pronta) return pronta;
    }
    throw new Error(`[peticao] gerar-inicial: ${j.error || `HTTP ${r.status}`}`);
  }
  return { html: j.html, viabilidade: j.viabilidade, documentos: j.documentos_necessarios, preco: j.preco };
}

// Lê a peça já gravada pela edge (status 'gerada'), esperando até ~4 min.
export async function esperarPecaGerada(entrevistaId, { tentativas = 16, intervaloMs = 15_000 } = {}) {
  const s = db();
  if (!s || !entrevistaId) return null;
  for (let i = 0; i < tentativas; i++) {
    const { data } = await s.from('inicial_entrevistas').select('status,peticao_html,viabilidade_analise,documentos_necessarios').eq('id', entrevistaId).maybeSingle();
    if (data?.status === 'gerada' && data.peticao_html) return { html: data.peticao_html, viabilidade: data.viabilidade_analise, documentos: data.documentos_necessarios, preco: null };
    await new Promise(res => setTimeout(res, intervaloMs));
  }
  return null;
}

// Entrevista deste processo que já tem a peça gerada (de uma tentativa anterior), se houver.
export async function entrevistaGerada(processoId) {
  const s = db();
  if (!s || !processoId) return null;
  const { data } = await s.from('inicial_entrevistas').select('id,viabilidade_analise,documentos_necessarios').eq('processo_id', processoId).eq('status', 'gerada').not('peticao_html', 'is', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
  return data || null;
}

// Linha de `distribuicoes` no mesmo formato que o IURIA já usa (ver registros reais do TJSP).
export function montarDistribuicao({ cliente, processoId, entrevistaId, triagem, escritorioId, criadoPor, anexos = [] }) {
  const c = triagem?.calculo || {};
  const end = (cliente.endereco || '');
  const m = end.match(/^(.*?),?\s*(?:n[ºo.]?\s*)?(\d+[A-Za-z]?)\s*(.*)$/);
  const ativo = [{
    tipo_pessoa: 'PF', nome: cliente.nome, cpf_cnpj: (cliente.cpf || '').replace(/\D/g, ''), cpf: (cliente.cpf || '').replace(/\D/g, ''), cnpj: '', razao_social: '',
    rg: cliente.rg || '', orgao_emissor: '', nacionalidade: cliente.nacionalidade || 'brasileiro(a)', estado_civil: cliente.estado_civil || '', profissao: cliente.profissao || '',
    logradouro: m ? m[1] : end, numero: m ? m[2] : '', complemento: m ? m[3].replace(/^[,\s-]+/, '') : '', bairro: cliente.bairro || '', cidade: cliente.cidade || '', uf: cliente.uf || '', cep: cliente.cep || '',
  }];
  const passivo = (triagem?.dividas || []).map(d => ({ tipo_pessoa: 'PJ', nome: d.credor, cpf_cnpj: '', logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', cep: '' }));
  return {
    criado_por: criadoPor, escritorio_id: escritorioId, cliente_id: cliente.id, processo_id: processoId, entrevista_id: entrevistaId,
    tribunal: process.env.TRIBUNAL_PADRAO || 'TJSP', sistema: process.env.SISTEMA_PADRAO || 'eproc', grau: '1', area_direito: 'Consumidor', competencia: 'Cível',
    jurisdicao: cliente.cidade ? `Foro de ${cliente.cidade}` : null, comarca: null,
    classe_nome: 'Procedimento de Repactuação de Dívidas (Superendividamento)', assuntos: [{ nome: 'Superendividamento' }],
    partes: { ativo, passivo }, valor_causa: c.saldo_total_considerado || null, justica_gratuita: true, segredo_justica: false, prioridade: false, tutela_liminar: true,
    anexos, status: 'rascunho',
    opcoes_adicionais: { lei_14289: false, juizo_digital: true, intervencao_mp: false, prioridade_idoso: false, prioridade_doenca: false, prioridade_crianca: false, prioridade_deficiencia: false, sem_interesse_conciliacao: false },
    observacao: 'Gerada pelo robô WhatsApp Superendividamento. ANTES DE PROTOCOLAR: (1) exportar o PDF da petição pela entrevista e anexar; (2) completar CNPJ e endereço de cada credor no polo passivo; (3) juntar extratos/contratos das dívidas; (4) conferir valor da causa. O robô não protocola.',
  };
}

// Orquestra: anexos → gerar-inicial → distribuicoes (rascunho) → aviso. Devolve { distribuicaoId, preco }.
export async function prepararProtocolo({ conversa, cliente, processoId, entrevistaId, escritorioId, historicoTexto, modelo, deps = {} }) {
  const s = db();
  const triagem = conversa.triagem || {};
  const anexos = [];
  for (const [slot, d] of Object.entries(triagem.documentos || {})) {
    const lista = Array.isArray(d) ? d : [d];
    for (const [i, x] of lista.entries()) if (x?.path) anexos.push({ nome: lista.length > 1 ? `${slot} ${i + 1}` : slot, tipo: slot === 'pessoal' ? 'RG / CPF' : slot === 'endereco' ? 'Comprovante de residência' : slot === 'renda' ? 'Comprovante de renda' : 'Outro', storage_path: x.path, mime_type: x.mime });
  }
  // PDFs assinados (declaração + procuração) já estão em `assinaturas.pdf_assinado_path`.
  if (s) {
    const ids = (triagem.assinaturas || []).map(a => a.autentiqueId).filter(Boolean);
    if (ids.length) {
      const { data } = await s.from('assinaturas').select('tipo_doc,nome_doc,pdf_assinado_path').in('autentique_id', ids);
      for (const a of data || []) if (a.pdf_assinado_path) anexos.push({ nome: `${a.nome_doc} (assinado).pdf`, tipo: a.tipo_doc === 'se_procuracao' ? 'Procuração' : 'Outro', storage_path: a.pdf_assinado_path, mime_type: 'application/pdf' });
    }
  }
  const gerar = deps.gerar || gerarPeticao;
  // Peça já gerada numa tentativa anterior: não gera de novo, só monta a distribuição.
  const pet = deps.pecaPronta || await gerar({ cliente, triagem, entrevistaId, anexos: anexos.filter(a => a.tipo !== 'Procuração'), historicoTexto, modelo });
  const linha = montarDistribuicao({ cliente, processoId, entrevistaId, triagem, escritorioId, criadoPor: cliente.criado_por, anexos });
  let distribuicaoId = null;
  if (deps.inserir) distribuicaoId = await deps.inserir(linha);
  else if (s) {
    const { data, error } = await s.from('distribuicoes').insert(linha).select('id').single();
    if (error) throw new Error(`[peticao] distribuicoes: ${error.message}`);
    distribuicaoId = data.id;
  }
  return { distribuicaoId, preco: pet.preco, viabilidade: pet.viabilidade };
}
