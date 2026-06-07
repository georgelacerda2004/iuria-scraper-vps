# Imagem oficial da Microsoft com Chromium + libs nativas pré-instaladas.
# Tag versionada pra evitar surpresa em update remoto.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Dependências antes do código pra aproveitar cache de layer
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Código da aplicação
COPY server.js ./
COPY scrapers/ ./scrapers/

# Usuário não-root (imagem do Playwright já cria o 'pwuser')
USER pwuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
