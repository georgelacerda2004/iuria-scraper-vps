# Robô WhatsApp — Superendividamento

Webhook da WhatsApp Cloud API (Meta) que recebe os leads do anúncio Click-to-WhatsApp,
se identifica como assistente virtual, pede consentimento (LGPD), registra a atribuição
do anúncio (`referral`) e grava tudo no Supabase do IURIA (tabelas `se_*`).

Estado desta versão: recepção + consentimento + **triagem por IA** (Claude) + handoff.
O upload de documentos, a cobrança Asaas e a assinatura Autentique entram nos próximos commits.

## Como a triagem funciona
- `lib/cerebro.js`: Claude (`claude-opus-5-5` por padrão) com três ferramentas:
  `calcular_comprometimento` (cálculo puro em `lib/calculo.js`), `registrar_triagem`
  (grava o resultado em `se_conversas.triagem` e muda a etapa para `viavel`/`inviavel`)
  e `encaminhar_advogado` (handoff). Loop manual: chama a API, executa a ferramenta,
  repete até vir texto.
- `conhecimento/superendividamento.md`: a base factual (lei, decreto, STF 2026, o que
  o "30 %" é de verdade). Entra no system prompt com cache. Edite o arquivo para
  mudar o que o robô sabe; não precisa mexer em código.
- Regras duras no prompt: identifica-se como robô, não promete resultado nem
  percentual, não fala de honorários, não pede documentos nesta fase.
- Fallback automático em caso de recusa do modelo está ligado (`CLAUDE_FALLBACKS=on`).

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
