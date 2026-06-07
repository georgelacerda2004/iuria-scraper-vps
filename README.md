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

Tribunais: `stj`, `tjsp` (validados), `stf`, `tst`, `tjpe`, `tjmg`, `tjrj` (skeleton).

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

## Custo operacional

- VPS DigitalOcean 2GB SP: US$ 12/mês (~R$ 60)
- Backup automático (opcional): +US$ 2.4/mês (~R$ 12)
- **Total: ~R$ 70/mês fixo**, sem limite de buscas (limite = capacidade CPU)

## Estrutura

```
iuria-scraper-vps/
├── server.js                 Express + auth + routing + cache
├── scrapers/
│   ├── stj.js                ✅ Validado
│   ├── tjsp.js               ✅ Validado
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

- [ ] Fase 2: validar scrapers STJ + TJSP localmente
- [ ] Fase 3: deploy na VPS + plugar no Supabase
- [ ] Fase 4: implementar STF + TST + TJPE + TJMG + TJRJ
- [ ] Futuro: rate limit por user_id (tracking de uso pra plano de cobrança)
- [ ] Futuro: métricas Prometheus + dashboard Grafana

## Licença

Uso interno IURIA. Não distribuir publicamente sem autorização.
