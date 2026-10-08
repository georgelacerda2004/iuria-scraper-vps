# Robô WhatsApp — Superendividamento

Webhook da WhatsApp Cloud API (Meta) que recebe os leads do anúncio Click-to-WhatsApp,
se identifica como assistente virtual, pede consentimento (LGPD), registra a atribuição
do anúncio (`referral`) e grava tudo no Supabase do IURIA (tabelas `se_*`).

Estado desta versão: recepção + consentimento + **triagem por IA** (Claude) + handoff +
**documentos pelo chat → cadastro no IURIA → cobrança Asaas + 3 PDFs no Autentique →
(pago e assinado) → processo + entrevista + aviso ao advogado**.
Depois disso, em segundo plano: **petição de repactuação pela edge `gerar-inicial`** e
**rascunho em `distribuicoes`** para o George revisar e assinar (`lib/peticao.js`).
E o **robô de campanha** do Meta (`lib/campanha.js`): cria o rascunho pausado, lê os
resultados a cada 4 h, cruza com o CRM do robô (leads qualificados e pagos por anúncio),
recomenda ou pausa (só com `CAMPANHA_AUTOPAUSAR=on`) e manda o relatório diário no Telegram.

## Protocolo: o que o robô faz e o que NÃO faz
- Faz: entrevista em `inicial_entrevistas` (status `gerada`, com o HTML da petição), linha em
  `distribuicoes` com status **`rascunho`**, partes estruturadas (autor completo; credores só
  com o nome), anexos (documentos do cliente + PDFs assinados), justiça gratuita e tutela.
- Não faz: protocolar, assinar, completar CNPJ dos credores. Isso é do George, no IURIA,
  com o certificado A3. A observação da distribuição lista o que falta.

## Robô de campanha
```bash
npm run campanha rascunho    # cria campanha + conjunto + 3 anúncios informativos, tudo PAUSADO
npm run campanha relatorio   # lê Meta + CRM e mostra o que pausaria (simulação)
npm run campanha ciclo       # idem; pausa de verdade se CAMPANHA_AUTOPAUSAR=on
```
Regras (reais): julga um anúncio só depois de gastar `CAMPANHA_GASTO_MINIMO` (60); pausa se
não gerou conversa, se custou mais que `CAMPANHA_TETO_CONVERSA` (25) por conversa sem lead
qualificado, ou mais que `CAMPANHA_TETO_QUALIFICADO` (120) por lead qualificado. Os textos
padrão são informativos (Provimento 205/2021): sem valores, sem promessa, sem "clique e reduza".
Imagens: passar URLs em `criarRascunho({ imagens })`; geração automática fica para a fase 2.

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
