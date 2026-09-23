# Robô WhatsApp — Superendividamento

Webhook da WhatsApp Cloud API (Meta) que recebe os leads do anúncio Click-to-WhatsApp,
se identifica como assistente virtual, pede consentimento (LGPD), registra a atribuição
do anúncio (`referral`) e grava tudo no Supabase do IURIA (tabelas `se_*`).

Estado desta versão: recepção + consentimento + handoff. A triagem por IA, o upload de
documentos, a cobrança Asaas e a assinatura Autentique entram nos próximos commits.

## Rodar local
```bash
cd bot && npm install && npm test        # smoke test sem rede
cp .env.example .env                      # preencher
npm start                                 # http://localhost:10000/health
```

## Deploy (Render)
Blueprint em `render.yaml` na raiz do repositório (serviço `superendividamento-bot`, rootDir `bot`).
Depois do deploy, no painel do app na Meta → WhatsApp → Configuração → Webhook:
- URL de callback: `https://<serviço>.onrender.com/webhook`
- Verificar token: o mesmo valor de `WEBHOOK_VERIFY_TOKEN`
- Campos: assinar `messages`

## Banco
`supabase/se_schema.sql` cria `se_conversas` e `se_mensagens` no projeto `juridicopro`.
Não foi aplicado; aplicar só com autorização do George.
