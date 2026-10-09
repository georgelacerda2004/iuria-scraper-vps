// Qualificação dos credores (réus) para a petição: razão social, CNPJ e endereço da sede.
// Regra do escritório: nunca deixar campo em branco. Primeiro o catálogo (instituições comuns no
// superendividamento); se o credor não estiver nele, pesquisa na internet com o Claude (web search)
// e devolve o dado encontrado. Tudo marcado com a fonte, para o advogado conferir antes de protocolar.
import Anthropic from '@anthropic-ai/sdk';

export const CATALOGO = [
  { chaves: ['santander', 'olé', 'ole consignado'], razao_social: 'BANCO SANTANDER (BRASIL) S.A.', cnpj: '90.400.888/0001-42', endereco: 'Avenida Presidente Juscelino Kubitschek, nº 2.041 e 2.235, Bloco A, Vila Olímpia, São Paulo/SP, CEP 04543-011' },
  { chaves: ['bradesco'], razao_social: 'BANCO BRADESCO S.A.', cnpj: '60.746.948/0001-12', endereco: 'Núcleo Cidade de Deus, s/nº, Vila Yara, Osasco/SP, CEP 06029-900' },
  { chaves: ['itaú', 'itau', 'itaucard', 'unibanco'], razao_social: 'ITAÚ UNIBANCO S.A.', cnpj: '60.701.190/0001-04', endereco: 'Praça Alfredo Egydio de Souza Aranha, nº 100, Torre Olavo Setubal, Parque Jabaquara, São Paulo/SP, CEP 04344-902' },
  { chaves: ['itaú consignado', 'itau consignado'], razao_social: 'ITAÚ CONSIGNADO S.A.', cnpj: '33.885.724/0001-19', endereco: 'Praça Alfredo Egydio de Souza Aranha, nº 100, Torre Conceição, Parque Jabaquara, São Paulo/SP, CEP 04344-902' },
  { chaves: ['banco do brasil', 'bb '], razao_social: 'BANCO DO BRASIL S.A.', cnpj: '00.000.000/0001-91', endereco: 'SAUN Quadra 5, Lote B, Torre I, Asa Norte, Brasília/DF, CEP 70040-912' },
  { chaves: ['caixa', 'cef'], razao_social: 'CAIXA ECONÔMICA FEDERAL', cnpj: '00.360.305/0001-04', endereco: 'SBS Quadra 4, Lotes 3/4, Asa Sul, Brasília/DF, CEP 70092-900' },
  { chaves: ['nubank', 'nu pagamentos', 'cartão nu', 'cartao nu'], razao_social: 'NU PAGAMENTOS S.A. — INSTITUIÇÃO DE PAGAMENTO (NUBANK)', cnpj: '18.236.120/0001-58', endereco: 'Rua Capote Valente, nº 39, Pinheiros, São Paulo/SP, CEP 05409-000', obs: 'cartão de crédito e conta' },
  { chaves: ['nu financeira', 'empréstimo nubank', 'emprestimo nubank'], razao_social: 'NU FINANCEIRA S.A. — SOCIEDADE DE CRÉDITO, FINANCIAMENTO E INVESTIMENTO', cnpj: '30.680.829/0001-43', endereco: 'Rua Capote Valente, nº 120, Pinheiros, São Paulo/SP, CEP 05409-000', obs: 'empréstimo pessoal' },
  { chaves: ['pine'], razao_social: 'BANCO PINE S.A.', cnpj: '62.144.175/0001-20', endereco: 'Avenida Presidente Juscelino Kubitschek, nº 1.830, Torre 4, 6º andar, Itaim Bibi, São Paulo/SP, CEP 04543-900' },
  { chaves: ['facta'], razao_social: 'FACTA FINANCEIRA S.A. — CRÉDITO, FINANCIAMENTO E INVESTIMENTO', cnpj: '15.581.638/0001-30', endereco: 'Rua dos Andradas, nº 1.409, 7º andar, Centro, Porto Alegre/RS, CEP 90020-011' },
  { chaves: ['321', 'tres dois um'], razao_social: '321 SOCIEDADE DE CRÉDITO DIRETO S.A.', cnpj: '54.647.259/0001-58', endereco: 'Avenida Carlos Gomes, nº 1.492, conjunto 611, Três Figueiras, Porto Alegre/RS, CEP 90480-002' },
  { chaves: ['all in cred', 'allincred'], razao_social: 'ALL IN CRED SOCIEDADE DE CRÉDITO DIRETO S.A.', cnpj: '51.414.521/0001-26', endereco: 'Rua José Maria Lisboa, nº 757, conjunto 107, Jardim Paulista, São Paulo/SP, CEP 01423-001' },
  { chaves: ['cooperserv'], razao_social: 'COOPERATIVA DE ECONOMIA E CRÉDITO MÚTUO — COOPERSERV (SICOOB COOPERSERV)', cnpj: '05.667.301/0001-97', endereco: 'Avenida Brasil, nº 830, Centro, Lençóis Paulista/SP, CEP 18682-060' },
  { chaves: ['pan'], razao_social: 'BANCO PAN S.A.', cnpj: '59.285.411/0001-13', endereco: 'Avenida Paulista, nº 1.374, 16º andar, Bela Vista, São Paulo/SP, CEP 01310-100' },
  { chaves: ['bmg'], razao_social: 'BANCO BMG S.A.', cnpj: '61.186.680/0001-74', endereco: 'Avenida Presidente Juscelino Kubitschek, nº 1.830, Bloco 01, 10º andar, Vila Nova Conceição, São Paulo/SP, CEP 04543-900' },
  { chaves: ['crefisa'], razao_social: 'CREFISA S.A. — CRÉDITO, FINANCIAMENTO E INVESTIMENTOS', cnpj: '60.779.196/0001-96', endereco: 'Rua Canadá, nº 390, Jardim América, São Paulo/SP, CEP 01436-900' },
  { chaves: ['safra'], razao_social: 'BANCO SAFRA S.A.', cnpj: '58.160.789/0001-28', endereco: 'Avenida Paulista, nº 2.100, Bela Vista, São Paulo/SP, CEP 01310-930' },
  { chaves: ['daycoval'], razao_social: 'BANCO DAYCOVAL S.A.', cnpj: '62.232.889/0001-90', endereco: 'Avenida Paulista, nº 1.793, Bela Vista, São Paulo/SP, CEP 01311-200' },
  { chaves: ['c6'], razao_social: 'BANCO C6 S.A.', cnpj: '31.872.495/0001-72', endereco: 'Avenida Nove de Julho, nº 3.186, Jardim Paulista, São Paulo/SP, CEP 01406-000' },
  { chaves: ['inter'], razao_social: 'BANCO INTER S.A.', cnpj: '00.416.968/0001-01', endereco: 'Avenida Barbacena, nº 1.219, Santo Agostinho, Belo Horizonte/MG, CEP 30190-131' },
  { chaves: ['mercantil'], razao_social: 'BANCO MERCANTIL DO BRASIL S.A.', cnpj: '17.184.037/0001-10', endereco: 'Rua Rio de Janeiro, nº 654, Centro, Belo Horizonte/MG, CEP 30160-912' },
  { chaves: ['votorantim', 'bv financeira', 'banco bv'], razao_social: 'BANCO VOTORANTIM S.A. (BV)', cnpj: '59.588.111/0001-03', endereco: 'Avenida das Nações Unidas, nº 14.171, Torre A, 18º andar, Vila Gertrudes, São Paulo/SP, CEP 04794-000' },
  { chaves: ['banrisul'], razao_social: 'BANCO DO ESTADO DO RIO GRANDE DO SUL S.A. (BANRISUL)', cnpj: '92.702.067/0001-96', endereco: 'Rua Capitão Montanha, nº 177, Centro Histórico, Porto Alegre/RS, CEP 90010-040' },
  { chaves: ['cetelem'], razao_social: 'BANCO CETELEM S.A.', cnpj: '00.558.456/0001-71', endereco: 'Alameda Rio Negro, nº 161, 17º andar, Alphaville, Barueri/SP, CEP 06454-000' },
  { chaves: ['original'], razao_social: 'BANCO ORIGINAL S.A.', cnpj: '92.894.922/0001-08', endereco: 'Rua General Furtado do Nascimento, nº 66, Alto de Pinheiros, São Paulo/SP, CEP 05465-070' },
  { chaves: ['mercado pago', 'mercadopago'], razao_social: 'MERCADO PAGO INSTITUIÇÃO DE PAGAMENTO LTDA.', cnpj: '10.573.521/0001-91', endereco: 'Avenida das Nações Unidas, nº 3.003, Bonfim, Osasco/SP, CEP 06233-903' },
  { chaves: ['picpay'], razao_social: 'PICPAY INSTITUIÇÃO DE PAGAMENTO S.A.', cnpj: '22.896.431/0001-10', endereco: 'Avenida Manuel Bandeira, nº 291, Bloco B, Vila Leopoldina, São Paulo/SP, CEP 05317-020' },
  { chaves: ['olé consignado', 'ole consignado'], razao_social: 'BANCO OLÉ CONSIGNADO S.A.', cnpj: '71.371.686/0001-75', endereco: 'Rua Alvarenga Peixoto, nº 974, Lourdes, Belo Horizonte/MG, CEP 30180-120' },
];

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Procura no catálogo pelo nome como a pessoa falou ("Nubank", "cartão do Bradesco", "Sicoob Cooperserv"...).
export function buscarCatalogo(nome) {
  const n = ' ' + norm(nome) + ' ';
  // Chaves mais longas primeiro, para "itaú consignado" vencer "itaú" e "nu financeira" vencer "nubank".
  const ordenado = [...CATALOGO].sort((a, b) => Math.max(...b.chaves.map(c => c.length)) - Math.max(...a.chaves.map(c => c.length)));
  for (const c of ordenado) if (c.chaves.some(ch => n.includes(norm(ch)))) return { razao_social: c.razao_social, cnpj: c.cnpj, endereco: c.endereco, obs: c.obs, fonte: 'catalogo' };
  return null;
}

// Credor fora do catálogo: pesquisa na internet com o Claude (ferramenta web_search do servidor).
export async function pesquisarNaInternet(nome, { api = new Anthropic(), modelo = process.env.CREDORES_MODELO || 'claude-opus-5-5' } = {}) {
  const r = await api.messages.create({
    model: modelo,
    max_tokens: 2000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'BR' } }],
    system: 'Você qualifica réus para petições iniciais no Brasil. Dado o nome de um credor (banco, financeira, loja, fintech, concessionária), pesquise e devolva a razão social completa, o CNPJ da MATRIZ (formato 00.000.000/0001-00) e o endereço completo da sede (logradouro, número, complemento, bairro, cidade/UF, CEP). Responda SOMENTE com um JSON: {"razao_social":"...","cnpj":"...","endereco":"...","confianca":"alta|media|baixa","fonte":"url"}. Se não encontrar com segurança, confianca "baixa" e campos vazios.',
    messages: [{ role: 'user', content: `Credor: ${nome}` }],
  });
  const texto = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return j.cnpj ? { ...j, fonte: 'internet: ' + (j.fonte || '') } : null; } catch { return null; }
}

// Qualifica uma lista de credores (nomes como vieram da triagem). Nunca devolve lacuna: quando nem o
// catálogo nem a internet resolvem, marca `pendente: true` para o advogado completar, e o aviso vai no briefing.
export async function qualificarCredores(nomes, deps = {}) {
  const pesquisar = deps.pesquisar || pesquisarNaInternet;
  const out = [];
  for (const nome of nomes.filter(Boolean)) {
    const cat = buscarCatalogo(nome);
    if (cat) { out.push({ nome, ...cat }); continue; }
    let web = null;
    // Sem chave da API (ou em teste) não pesquisa: marca pendente para o advogado.
    try { web = (process.env.NODE_ENV === 'test' || !process.env.ANTHROPIC_API_KEY) && !deps.pesquisar ? null : await pesquisar(nome); } catch (e) { console.warn('[credores] pesquisa falhou:', nome, e.message); }
    out.push(web && web.confianca !== 'baixa' && web.cnpj ? { nome, ...web, fonte: /^internet/.test(web.fonte || '') ? web.fonte : 'internet: ' + (web.fonte || '') } : { nome, razao_social: nome, cnpj: '', endereco: '', pendente: true, fonte: 'nao_encontrado' });
  }
  return out;
}

export function descreverCredor(c) {
  if (c.pendente) return `${c.razao_social} (CNPJ e endereço: A CONFIRMAR pelo advogado antes do protocolo)`;
  return `${c.razao_social}, inscrita no CNPJ sob o nº ${c.cnpj}, com sede na ${c.endereco}`;
}
