# Robô WhatsApp — Superendividamento

Webhook da WhatsApp Cloud API (Meta) que recebe os leads do anúncio Click-to-WhatsApp,
se identifica como assistente virtual, pede consentimento (LGPD), registra a atribuição
do anúncio (`referral`) e grava tudo no Supabase do IURIA (tabelas `se_*`).

Estado desta versão: recepção + consentimento + **triagem por IA** (Claude) + handoff +
**documentos pelo chat → cadastro no IURIA → cobrança Asaas + 3 PDFs no Autentique →
(pago e assinado) → processo + entrevista + aviso ao advogado**.
Falta: gerar a petição (`gerar-inicial`) e enfileirar em `distribuicoes` (semana 2).

## Etapas da conversa (`se_conversas.etapa`)
`novo → consentimento → triagem → viavel | inviavel → docs → pagamento_assinatura → cliente`
(`handoff` em qualquer ponto; `encerrado` se recusar o consentimento).

## Pós-triagem (`lib/captacao.js`)
- **docs**: pede RG/CNH, comprovante de endereço e de renda, um por vez. Cada arquivo vai
  para o Storage do IURIA (`documentos/se-uploads/...`) e passa pela edge `classificar-doc`
  (OCR) para preencher nome, CPF, RG e endereço.
- **cadastro**: `clientes` (dedup por CPF no escritório), `documentos`, cliente no Asaas,
  cobrança única da entrada (`externalReference = SE|<conversa>`), 3 PDFs gerados em
  `lib/documentos.js` (procuração, contrato, declaração de superendividamento) e enviados
  pela edge `autentique-enviar` com link de assinatura.
- **pagamento_assinatura**: o webhook do Asaas (`POST /webhooks/asaas`) e um verificador a
  cada 3 min checam pagamento (API Asaas) e assinaturas (tabela `assinaturas`, que o
  `autentique-webhook` do IURIA já mantém). Quando os dois fecham: `processos`,
  `inicial_entrevistas`, `honorarios`, aviso no Telegram e mensagem ao cliente.

## Textos jurídicos
Os modelos em `lib/documentos.js` são um ponto de partida para o advogado revisar
(contrato com entrada de R$ 500, obrigação de meio, LGPD, foro). Nome, OAB e foro vêm
do ambiente (`ADVOGADO_NOME`, `ADVOGADO_OAB`, `FORO_CONTRATO`).

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
