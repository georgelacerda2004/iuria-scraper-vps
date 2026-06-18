# DEPLOY_VPS.md — Fase 3: provisionar a VPS e plugar no Supabase

Guia operacional do que **o George** precisa fazer para colocar o
`iuria-scraper-vps` no ar. O objetivo é que o deploy seja mecânico: provisionar
a VPS, rodar um comando, copiar o token e colar no Supabase.

> Segredos (senha da VPS, token gerado, secrets do Supabase) são só do George.
> O Claude **não** pede, não loga e não commita esses valores. Os scripts que
> contêm senha em texto (`_deploy_vps.py`, `_deploy_vultr.py`) ficam fora do
> Git (estão no `.gitignore`) — são do George e rodam só na máquina dele.

---

## 0. O que só depende do George (resumo)

| # | Passo | Responsável |
|---|-------|-------------|
| 1 | Contratar a VPS (datacenter, IP fixo, specs abaixo) | **George** |
| 2 | Apontar DNS `scraper.iuria.com.br` → IP da VPS | **George** (painel GoDaddy) |
| 3 | Rodar o `setup.sh` na VPS (1 comando) | **George** (SSH) |
| 4 | Copiar o `IURIA_SCRAPER_TOKEN` gerado | **George** |
| 5 | Colar `IURIA_SCRAPER_URL` + `IURIA_SCRAPER_TOKEN` nos secrets do Supabase | **George** |
| 6 | (Quando autorizar) deploy da edge `buscar-jurisprudencia` para usar a VPS | dev/juris, sob ordem do George |

Tudo que está no repo (Docker, Caddy, setup.sh, scrapers STJ+TJSP) já está
pronto. O que falta é exclusivamente provisionar a máquina e setar os secrets —
itens 1 a 5 acima.

---

## 1. Que tipo de VPS contratar

Requisito não negociável: **IP de datacenter** (não residencial). É justamente
o IP "limpo" de datacenter que faz o STJ aceitar o desafio Cloudflare e o eSAJ
do TJSP não disparar o reCAPTCHA — foi o bloqueio observado na validação local
da Fase 2 (ver README, seção "Validação local Fase 2").

Specs mínimas (Chromium headless é o que pesa):

| Recurso | Mínimo | Recomendado |
|---|---|---|
| RAM | 2 GB | 4 GB |
| vCPU | 1 | 2 |
| Disco | 25 GB SSD | 40 GB SSD |
| SO | **Ubuntu 22.04 LTS** | Ubuntu 22.04 LTS |
| Região | Brasil / São Paulo (menor latência aos tribunais) | SP |

Provedores que servem (qualquer um com Ubuntu 22.04 e IP de datacenter):
DigitalOcean (Droplet 2 GB SP, ~US$ 12/mês), Vultr (SP), Contabo, Hetzner,
Magalu Cloud. Custo de referência: **~R$ 60–70/mês**.

> Observação: o `shm_size` do container do Chromium está fixado em 2 GB no
> `docker-compose.yml`. Numa VPS de 2 GB de RAM total isso funciona porque shm é
> alocado sob demanda, mas se a máquina ficar apertada sob carga, suba para 4 GB
> de RAM.

---

## 2. Como dar acesso (SSH)

Na criação da VPS, prefira **chave SSH** em vez de senha. Duas opções:

- **A (recomendada):** no painel do provedor, cole sua chave pública
  (`~/.ssh/id_ed25519.pub` ou similar) no momento de criar a máquina. O login
  passa a ser `ssh root@IP` sem senha.
- **B (senha):** o provedor manda a senha de root por e-mail/painel. Funciona,
  mas troque por chave SSH no primeiro login (`ssh-copy-id` ou colando a chave
  em `~/.ssh/authorized_keys`).

O Claude **não** precisa e **não** deve receber essas credenciais. Quem conecta
na VPS é o George.

Portas: o `setup.sh` configura o firewall (UFW) sozinho — libera **SSH (22)**,
**80** e **443** (TCP e UDP/HTTP3) e bloqueia o resto. Não é preciso abrir nada
manualmente. Confira só que o provedor não tem um firewall externo (Security
Group) bloqueando 80/443 — se tiver, libere lá também.

---

## 3. DNS (antes de subir o Caddy)

No painel da GoDaddy (o domínio `iuria.com.br` é do George), crie um registro:

```
Tipo: A
Nome: scraper            (vira scraper.iuria.com.br)
Valor: <IP público da VPS>
TTL: 600
```

Aponte o DNS **antes** de rodar o `setup.sh` com domínio. O Caddy emite o
certificado SSL (Let's Encrypt) no primeiro acesso, e isso só funciona se o
`scraper.iuria.com.br` já resolver para o IP da VPS. Propagação: ~2–10 min.

> Se quiser subir **sem DNS** primeiro (testar por IP, HTTP puro), dá: rode o
> `setup.sh` com `DOMAIN=:80` que o Caddy escuta na porta 80 sem SSL. Depois,
> com o DNS apontado, troque o `.env` para `DOMAIN=scraper.iuria.com.br` e rode
> `docker compose up -d` de novo para o Caddy pegar o SSL.

---

## 4. Deploy — 1 comando (caminho Docker, o oficial)

Com a VPS criada e o DNS apontado, conecte por SSH como root e rode:

```bash
ssh root@SEU_IP

curl -fsSL https://raw.githubusercontent.com/georgelacerda2004/iuria-scraper-vps/main/setup.sh \
  | DOMAIN=scraper.iuria.com.br bash
```

O `setup.sh` (idempotente — pode rodar de novo sem quebrar) faz:

1. `apt update` + deps básicas (curl, git, ufw, openssl);
2. instala Docker Engine + plugin Compose (canal oficial Docker);
3. configura o firewall UFW (SSH + 80 + 443);
4. clona o repo em `/opt/iuria-scraper`;
5. gera um `.env` com `IURIA_SCRAPER_TOKEN` aleatório (`openssl rand -hex 32`);
6. sobe `docker compose up -d` (app Node/Playwright + Redis + Caddy).

Tempo total: ~3–5 min (o build da imagem do Playwright é o que demora).

### Variáveis de ambiente (o que o `.env` carrega)

O `setup.sh` já cria o `.env`. As variáveis (valores **não** vão neste repo):

| Variável | O que é | Quem define |
|---|---|---|
| `IURIA_SCRAPER_TOKEN` | Bearer token que autentica o Supabase → VPS | gerado pelo `setup.sh` |
| `DOMAIN` | subdomínio do scraper (ex.: `scraper.iuria.com.br`) | George, no comando do deploy |

Outras variáveis têm default embutido e normalmente **não** precisam ser
setadas: `PORT=3000`, `REDIS_URL=redis://redis:6379`, `CACHE_TTL=86400` (24 h).

---

## 5. Verificar que subiu

```bash
# Pegar o token gerado (vai precisar dele no Supabase)
cat /opt/iuria-scraper/.env

# Health check (sem auth)
curl https://scraper.iuria.com.br/health
# Esperado: {"status":"ok","redis":"PONG","browser":"cold",...}

# Listar tribunais (precisa do token)
curl https://scraper.iuria.com.br/tribunais \
  -H "Authorization: Bearer <TOKEN_DO_ENV>"

# Teste real de busca no STJ (aqui valida o IP limpo da Fase 3)
curl -X POST https://scraper.iuria.com.br/buscar/stj \
  -H "Authorization: Bearer <TOKEN_DO_ENV>" \
  -H "Content-Type: application/json" \
  -d '{"busca":"dano moral","limit":5}'
```

Se o `/buscar/stj` retornar acórdãos, o IP de datacenter passou pelo Cloudflare
(o que não acontecia no IP residencial da Fase 2). Se ainda vier erro de
bloqueio, o scraper reporta a causa real no campo `error` (não retorna vazio
silencioso) — é o sinal de que precisamos ajustar stealth/headers para aquele
provedor de IP.

---

## 6. Plugar no Supabase (re-ligar)

No Supabase Dashboard do projeto (`mvlhkyqsywqhlrqrdeje`):

1. **Edge Functions → Secrets** (ou Project Settings → Edge Functions).
2. Adicione dois secrets (cole os valores reais — eles ficam só no Supabase):
   - `IURIA_SCRAPER_URL` = `https://scraper.iuria.com.br`
   - `IURIA_SCRAPER_TOKEN` = `<token gerado no passo 4>`
3. A edge `buscar-jurisprudencia` passa a ter a VPS na cadeia de provider
   (Jurisprudências.ai → **VPS** → DataJud, conforme a estratégia v12). O deploy
   dessa edge para efetivamente usar a VPS só acontece **sob autorização do
   George** — não é feito automaticamente.

> O badge de FONTE no app continua válido: quando o resultado vier da VPS, o UI
> deve indicar a fonte (scraper do tribunal), distinta de DataJud e do provider.

---

## 7. Operação do dia a dia

```bash
# Logs ao vivo
docker compose -f /opt/iuria-scraper/docker-compose.yml logs -f

# Restart
cd /opt/iuria-scraper && docker compose restart

# Atualizar após push no GitHub
cd /opt/iuria-scraper && git pull && docker compose up -d --build

# Status dos containers
cd /opt/iuria-scraper && docker compose ps
```

Os 3 containers (`app`, `redis`, `caddy`) sobem com `restart: unless-stopped`,
então reiniciam sozinhos no boot da VPS e em caso de crash. Não precisa de pm2
nem systemd no caminho Docker — o próprio Docker é o supervisor.

---

## Apêndice A — Deploy sem Docker (Node + Playwright + systemd)

Caminho alternativo, caso por algum motivo não se queira Docker na VPS. **O
caminho oficial e testado é o Docker (seções 4–7).** Este apêndice existe só
para referência.

```bash
# 1. Node 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 2. Dependências de SO do Chromium headless (o que a imagem do Playwright já traz)
#    O próprio Playwright instala isso com --with-deps:
mkdir -p /opt/iuria-scraper && cd /opt/iuria-scraper
git clone https://github.com/georgelacerda2004/iuria-scraper-vps.git .
npm install --omit=dev
npx playwright install --with-deps chromium   # baixa Chromium + libs de SO

# 3. Redis local
apt-get install -y redis-server
systemctl enable --now redis-server

# 4. .env (gere o token você mesmo)
printf 'IURIA_SCRAPER_TOKEN=%s\nREDIS_URL=redis://127.0.0.1:6379\nPORT=3000\n' \
  "$(openssl rand -hex 32)" > /opt/iuria-scraper/.env
chmod 600 /opt/iuria-scraper/.env

# 5. Serviço systemd
cat > /etc/systemd/system/iuria-scraper.service <<'UNIT'
[Unit]
Description=IURIA Scraper VPS
After=network.target redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/iuria-scraper
EnvironmentFile=/opt/iuria-scraper/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now iuria-scraper
systemctl status iuria-scraper
```

Neste caminho, o TLS/HTTPS fica por sua conta (Nginx ou Caddy standalone na
frente do `:3000`). No caminho Docker, o Caddy já resolve isso automaticamente —
por isso o Docker é o recomendado.

---

## Estado da Fase 3

- [x] Repo pronto: Docker + Caddy + setup.sh + scrapers STJ/TJSP (Fase 2)
- [x] Documentação de deploy mecânico (este arquivo)
- [ ] **George:** contratar VPS (datacenter SP, Ubuntu 22.04, ≥2 GB RAM)
- [ ] **George:** apontar DNS `scraper.iuria.com.br` → IP
- [ ] **George:** rodar `setup.sh` + copiar token
- [ ] **George:** setar `IURIA_SCRAPER_URL` + `IURIA_SCRAPER_TOKEN` no Supabase
- [ ] re-validar STJ/TJSP com IP limpo (deve passar o Cloudflare/reCAPTCHA)
- [ ] (sob ordem do George) deploy da edge `buscar-jurisprudencia` usando a VPS
