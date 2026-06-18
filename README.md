# IURIA Scraper VPS

Servidor de scraping de jurisprudência dos tribunais brasileiros para o IURIA
(iuria.com.br). Roda em VPS própria com Playwright headless (browser real),
passando pelo Cloudflare anti-bot que bloqueia requests HTTP simples.

## Por que existe

Em produção, descobrimos que TODOS os tribunais BR (STF, STJ, TST, TJSP, etc)
têm Cloudflare na frente. Edge Function Deno do Supabase **não consegue passar**
— bate em HTTP 202/403/405. A solução é browser real (Playwright) numa VPS
própria. Custo: R$ 60/mês (Droplet DigitalOcean 2GB SP region).

## Arquitetura

```
Frontend IURIA (Vercel)
        ↓
Supabase Edge Function "buscar-jurisprudencia"
        ↓ (HTTPS + Bearer token)
VPS (Caddy → Node/Express → Playwright → Tribunal)
        ↓
Redis (cache 24h: busca repetida = <50ms)
```

## Endpoints

Todos exigem header `Authorization: Bearer <IURIA_SCRAPER_TOKEN>`.

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Health check (sem auth) |
| `GET` | `/tribunais` | Lista tribunais com scraper implementado |
| `POST` | `/buscar/:tribunal` | Body: `{busca, dataIni?, dataFim?, limit?, noCache?}` |

Tribunais: `stj`, `tjsp` (scrapers prontos, fluxo validado localmente — **bloqueados por
anti-bot fora da VPS**, ver "Validação local Fase 2" abaixo), `stf`, `tst`, `tjpe`,
`tjmg`, `tjrj` (skeleton).

### Exemplo

```bash
curl -X POST https://scraper.iuria.com.br/buscar/stj \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"busca":"dano moral","limit":10}'
```

## Deploy

Pré-requisitos:
- VPS Ubuntu 22.04 LTS (DigitalOcean Droplet 2GB SP recomendado, ~US$ 12/mês)
- Domínio próprio com DNS apontando pra IP da VPS (ex: `scraper.iuria.com.br`)
- Acesso SSH como root

### 1 comando (após DNS apontado):

```bash
ssh root@SEU_IP
curl -fsSL https://raw.githubusercontent.com/georgelacerda2004/iuria-scraper-vps/main/setup.sh \
  | DOMAIN=scraper.iuria.com.br bash
```

O script:
1. Instala Docker + Compose
2. Configura firewall (UFW: SSH + 80 + 443)
3. Clona esse repo em `/opt/iuria-scraper`
4. Gera token aleatório em `.env`
5. Sobe `docker compose up -d` (app + Redis + Caddy)
6. Caddy obtém SSL automático no 1º acesso ao DOMAIN

Tempo total: ~3 minutos.

### Após deploy

```bash
# Pegar o token gerado pra adicionar no Supabase
cat /opt/iuria-scraper/.env

# Ver logs ao vivo
docker compose -f /opt/iuria-scraper/docker-compose.yml logs -f

# Restart
cd /opt/iuria-scraper && docker compose restart

# Update após push no GitHub
cd /opt/iuria-scraper && git pull && docker compose up -d --build
```

## Adicionar no Supabase

1. Supabase Dashboard → Edge Functions → Secrets
2. Adicione:
   - `IURIA_SCRAPER_URL=https://scraper.iuria.com.br`
   - `IURIA_SCRAPER_TOKEN=<token-gerado-pelo-setup>`
3. Edge function `buscar-jurisprudencia` v11 (próximo deploy) vai usar isso.

## Validação local Fase 2 (STJ + TJSP)

Rodada em 2026-06-18 a partir de IP residencial/local (`npm run test:stj` / `test:tjsp`,
harness em `tests/_harness.js`, mesmo setup stealth do `server.js`). Resultado:

| Tribunal | Endpoint que o scraper alcança | Bloqueio observado | Ementa real? |
|---|---|---|---|
| **STJ** | `scon.stj.jus.br/SCON/pesquisar.jsp` | **HTTP 403 + Cloudflare/CSID** — interstitial "Verificação automática em andamento" com token `__cf_chl_rt_tk` e RayID. O stealth não passou o desafio neste IP (esperado em IP residencial). | Não — bloqueado antes da listagem |
| **TJSP** | `esaj.tjsp.jus.br/cjsg/resultadoCompleta.do` | **reCAPTCHA gate** — o eSAJ navega corretamente até a página de resultado, mas serve um nó reCAPTCHA visível + zero blocos `.fundocinza1` (detecta a sessão como automação). NÃO há Cloudflare no eSAJ (HTTP 200). | Não — lista de acórdãos gateada por captcha |

**Conclusão:** o código dos dois scrapers está correto — o fluxo (busca → submit → página
de resultado) foi validado ao vivo e ambos chegam ao endpoint certo. O que falta é
**IP "limpo" de datacenter (a VPS da Fase 3)**: o STJ aceita o desafio Cloudflare nesse
tipo de IP, e o eSAJ do TJSP tende a não disparar o reCAPTCHA. Por isso os scrapers hoje
**falham EXPLICITAMENTE** (lançam erro descrevendo o bloqueio) em vez de retornar vazio
silencioso — assim o `server.js` reporta a causa real e a edge function pode dar fallback.

Pré-requisitos pra rodar a validação local:
```bash
npm install                 # instala playwright-extra + stealth (gitignored)
npx playwright install chromium
npm run test:stj            # ou: node tests/test-stj.js "dano moral consumidor"
npm run test:tjsp           # ou: node tests/test-tjsp.js "auxílio-doença" headful
```

## Custo operacional

- VPS DigitalOcean 2GB SP: US$ 12/mês (~R$ 60)
- Backup automático (opcional): +US$ 2.4/mês (~R$ 12)
- **Total: ~R$ 70/mês fixo**, sem limite de buscas (limite = capacidade CPU)

## Estrutura

```
iuria-scraper-vps/
├── server.js                 Express + auth + routing + cache
├── scrapers/
│   ├── stj.js                Fluxo OK; bloqueado por Cloudflare/CSID fora da VPS
│   ├── tjsp.js               Fluxo OK; reCAPTCHA gate fora da VPS
│   ├── stf.js                TODO Fase 4
│   ├── tst.js                TODO Fase 4
│   ├── tjpe.js               TODO Fase 4
│   ├── tjmg.js               TODO Fase 4
│   └── tjrj.js               TODO Fase 4
├── Dockerfile                Imagem oficial Playwright + Node 20
├── docker-compose.yml        app + redis + caddy
├── Caddyfile                 Reverse proxy + SSL automático
├── setup.sh                  Provisionamento 1-comando
├── .env.example              Template (gerado em .env pelo setup)
└── README.md
```

## Próximos passos

- [x] Fase 2: scrapers STJ + TJSP construídos e fluxo validado localmente
      (ementa real bloqueada por anti-bot fora da VPS — ver "Validação local Fase 2")
- [ ] Fase 3: deploy na VPS + plugar no Supabase + re-validar STJ/TJSP com IP limpo
- [ ] Fase 4: implementar STF + TST + TJPE + TJMG + TJRJ
- [ ] Futuro: rate limit por user_id (tracking de uso pra plano de cobrança)
- [ ] Futuro: métricas Prometheus + dashboard Grafana

## Licença

Uso interno IURIA. Não distribuir publicamente sem autorização.
