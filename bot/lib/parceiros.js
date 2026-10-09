// Área do advogado parceiro: cadastro com aceite do termo, acesso por link com token (e-mail), ofertas e lances,
// e os casos comprados (contato + conversa). Rotas: /parceiros, /parceiros/termos, /parceiros/painel, /parceiros/api/*.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { lancar, visaoParceiro, TERMO_VERSAO, CFG } from './mercado.js';
import { enviarEmail, esc } from './email.js';
import { avisarOperador } from './iuria.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const limpo = (v, n = 120) => String(v || '').trim().slice(0, n);

export function montarRouter() {
  const r = express.Router();
  r.get('/', (_req, res) => res.sendFile(path.join(AQUI, '..', 'parceiros', 'index.html')));
  r.get('/termos', (_req, res) => res.sendFile(path.join(AQUI, '..', 'parceiros', 'termos.html')));
  r.get('/painel', (_req, res) => res.sendFile(path.join(AQUI, '..', 'parceiros', 'index.html')));

  // Cadastro: cria o advogado com termo aceito e manda o link de acesso por e-mail.
  r.post('/api/cadastro', async (req, res) => {
    try {
      const b = req.body || {};
      const nome = limpo(b.nome), oab = limpo(b.oab, 20), uf = limpo(b.uf, 2).toUpperCase(), email = limpo(b.email).toLowerCase();
      if (!nome || !oab || !uf || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ erro: 'nome, OAB, UF e e-mail são obrigatórios' });
      if (b.aceite !== true) return res.status(400).json({ erro: 'é preciso aceitar o termo' });
      const s = db(); if (!s) return res.status(503).json({ erro: 'sem banco' });
      const ip = (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
      const linha = { nome, oab, uf, email, whatsapp: limpo(b.whatsapp, 20).replace(/\D/g, '') || null, cpf_cnpj: limpo(b.cpf_cnpj, 20).replace(/\D/g, '') || null, cidade: limpo(b.cidade) || null, termo_versao: TERMO_VERSAO, termo_aceito_em: new Date().toISOString(), termo_ip: ip, ativo: true };
      const { data, error } = await s.from('se_advogados').upsert(linha, { onConflict: 'email' }).select('id,nome,email,token').single();
      if (error) throw new Error(error.message);
      const C = CFG(); const link = `${C.url}/parceiros/painel?t=${data.token}`;
      const mail = await enviarEmail({ para: data.email, assunto: `Seu acesso à plataforma de indicação (${C.plataforma})`, texto: `Olá, ${data.nome}. Cadastro feito. Seu link de acesso (guarde, é pessoal):\n${link}\n\nVocê recebe um e-mail a cada novo caso aberto.`, html: `<p>Olá, ${esc(data.nome)}. Cadastro feito.</p><p>Seu link de acesso (guarde, é pessoal): <a href="${link}">${link}</a></p><p>Você recebe um e-mail a cada novo caso aberto.</p>` });
      await avisarOperador(`NOVO ADVOGADO PARCEIRO: ${nome} (OAB/${uf} ${oab}) · ${email}${mail.ok ? '' : ' · e-mail não enviado: ' + mail.motivo}`);
      // Sem e-mail configurado, devolve o token na resposta para a pessoa não ficar sem acesso.
      res.json({ ok: true, email_enviado: mail.ok, token: mail.ok ? undefined : data.token });
    } catch (e) { res.status(500).json({ erro: e.message }); }
  });

  // Autenticação por token (query ?t= ou header x-parceiro).
  r.use('/api', async (req, res, next) => {
    const t = req.get('x-parceiro') || req.query.t;
    if (!t) return res.status(401).json({ erro: 'sem token' });
    const s = db(); if (!s) return res.status(503).json({ erro: 'sem banco' });
    const { data: adv } = await s.from('se_advogados').select('*').eq('token', String(t)).maybeSingle();
    if (!adv || !adv.ativo) return res.status(401).json({ erro: 'acesso inválido' });
    req.adv = adv;
    s.from('se_advogados').update({ ultimo_acesso_em: new Date().toISOString() }).eq('id', adv.id).then(() => {}, () => {});
    next();
  });
  r.get('/api/eu', (req, res) => res.json({ id: req.adv.id, nome: req.adv.nome, oab: req.adv.oab, uf: req.adv.uf, email: req.adv.email, termo_versao: req.adv.termo_versao, termo_aceito_em: req.adv.termo_aceito_em, cfg: { incremento: CFG().incremento, plataforma: CFG().plataforma } }));
  r.get('/api/visao', async (req, res) => { try { res.json(await visaoParceiro(req.adv)); } catch (e) { res.status(500).json({ erro: e.message }); } });
  r.post('/api/ofertas/:id/lance', async (req, res) => {
    try { res.json(await lancar(req.params.id, req.adv.id, Number(req.body?.valor))); }
    catch (e) { res.status(400).json({ erro: e.message }); }
  });
  return r;
}
