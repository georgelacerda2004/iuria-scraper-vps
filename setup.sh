#!/usr/bin/env bash
# setup.sh — provisionamento ÚNICO da VPS Ubuntu 22.04 pro iuria-scraper.
#
# Esse script é idempotente (pode rodar várias vezes). Faz:
#   1. Atualiza apt + instala dependências mínimas (curl, ca-certificates, ufw)
#   2. Instala Docker Engine + plugin compose (oficial Docker, não snap)
#   3. Configura firewall: bloqueia tudo, libera SSH/HTTP/HTTPS
#   4. Cria pasta /opt/iuria-scraper, gera .env com token aleatório
#   5. Sobe docker compose up -d
#
# Uso (na VPS, como root):
#   curl -fsSL https://raw.githubusercontent.com/SEU-USUARIO/iuria-scraper-vps/main/setup.sh | DOMAIN=scraper.iuria.com.br bash
#
# OU se preferir mais controle:
#   git clone https://github.com/SEU-USUARIO/iuria-scraper-vps.git /opt/iuria-scraper
#   cd /opt/iuria-scraper
#   DOMAIN=scraper.iuria.com.br ./setup.sh

set -euo pipefail

APP_DIR="/opt/iuria-scraper"
REPO_URL="${REPO_URL:-https://github.com/georgelacerda2004/iuria-scraper-vps.git}"
DOMAIN="${DOMAIN:?DOMAIN env var obrigatória — ex: DOMAIN=scraper.iuria.com.br}"

echo "==> [1/6] Atualizando apt e instalando dependências básicas..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw openssl

echo "==> [2/6] Instalando Docker Engine (canal oficial)..."
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "Docker já instalado: $(docker --version)"
fi
systemctl enable docker
systemctl start docker

echo "==> [3/6] Configurando firewall (UFW)..."
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp # HTTP/3 (Caddy suporta)
ufw --force enable

echo "==> [4/6] Clonando/atualizando repositório..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> [5/6] Configurando .env..."
if [ ! -f "$APP_DIR/.env" ]; then
  TOKEN="$(openssl rand -hex 32)"
  cat > "$APP_DIR/.env" <<EOF
IURIA_SCRAPER_TOKEN=$TOKEN
DOMAIN=$DOMAIN
EOF
  echo ""
  echo "==============================================="
  echo "  TOKEN GERADO (anote ou pegue depois em .env):"
  echo "  IURIA_SCRAPER_TOKEN=$TOKEN"
  echo "==============================================="
  echo ""
else
  echo ".env já existe (mantido). Pra ver o token: cat $APP_DIR/.env"
fi

echo "==> [6/6] Subindo containers (build + up)..."
cd "$APP_DIR"
docker compose pull --quiet || true
docker compose build
docker compose up -d

echo ""
echo "============================================================"
echo "  ✅ DEPLOY COMPLETO"
echo "============================================================"
echo ""
echo "Próximos passos:"
echo "  1. Aponte DNS: A record $DOMAIN  ->  $(curl -fsSL -4 ifconfig.me)"
echo "  2. Aguarde ~2 min pro DNS propagar"
echo "  3. Caddy faz SSL automático no 1º acesso a https://$DOMAIN"
echo "  4. Teste: curl https://$DOMAIN/health"
echo "  5. Pegue o token: cat $APP_DIR/.env"
echo ""
echo "Logs ao vivo:  docker compose -f $APP_DIR/docker-compose.yml logs -f"
echo "Restart:       cd $APP_DIR && docker compose restart"
echo "Update:        cd $APP_DIR && git pull && docker compose up -d --build"
echo "============================================================"
