# Robô de protocolo (e-SAJ TJSP) — instalação no PC do escritório

O robô lê a fila do painel da Paula, baixa os PDFs do pacote, preenche o peticionamento inicial no e-SAJ e devolve o número do processo. Ele só age sobre itens que o advogado aprovou no painel. O certificado A3 do advogado que assina a peça precisa estar plugado no PC.

## 1. Instalar (uma vez) — Windows, PowerShell
```powershell
winget install OpenJS.NodeJS.LTS          # Node 22 (se ainda não tiver)
mkdir C:\robo-protocolo; cd C:\robo-protocolo
# copie para cá os arquivos da pasta bot/robo do repositório (robo.mjs, passos-esaj.json, package.json, config.example.json)
npm install
npx playwright install chrome              # usa o Google Chrome instalado (necessário para o certificado e o Web Signer)
copy config.example.json config.json       # edite: painel_senha (a senha do painel) e as pastas
```

Em `config.json`, `certificado_nome` é o trecho do nome que escolhe o certificado na lista do e-SAJ (ex.: `ALESSANDRO`).

Pré-requisitos no mesmo Chrome do perfil do robô (abra uma vez com `npm run ensaio` e configure):
- Extensão **Web Signer** (Softplan) instalada e o programa Web Signer rodando **na mesma versão da extensão** (baixe em websigner.softplan.com.br/Setup; instalar exige administrador). Versão diferente deixa a lista de certificados vazia.
- Driver do token (SafeNet/Gemalto ou o do seu A3) instalado; o certificado aparece em `certmgr.msc` > Pessoal.
- Para o Chrome escolher o certificado sem perguntar, crie a política no Registro (como administrador):
```powershell
reg add "HKLM\SOFTWARE\Policies\Google\Chrome\AutoSelectCertificateForUrls" /v 1 /t REG_SZ /d "{\"pattern\":\"https://esaj.tjsp.jus.br\",\"filter\":{}}" /f
```
O PIN do token ainda é digitado pelo operador na janela do Web Signer. A digitação automática do PIN (lida do Cofre de Credenciais do Windows) é a etapa seguinte, depois do primeiro protocolo real.

## 2. Primeiro teste (hoje): modo ensaio
```powershell
npm run ensaio -- --item=220cbdea     # --item escolhe a distribuição (início do id); sem ele pega a primeira da fila
```
Para mapear as telas pelo CDP, coloque `"cdp_porta": 9333` no config.json durante o ensaio e volte para `null` depois.

O robô abre o Chrome, pega o primeiro item aprovado da fila, baixa os PDFs para `downloads\<id>` e vai executando `passos-esaj.json`. Nos passos marcados como `pausar` ele espera você (ou o Hermes) fazer na tela e apertar Enter. Ele **para antes de "Protocolar"** e deixa o navegador aberto: salve o rascunho no e-SAJ, confira tudo e feche. Nada é enviado ao painel no ensaio.

Durante o ensaio, grave as telas (o Hermes faz isso): os cliques de "Partes" e "Documentos" viram passos novos em `passos-esaj.json`, e os nomes exatos das opções de Foro, Classe e Assunto são ajustados no mesmo arquivo.

## 3. Protocolo real assistido
```powershell
npm run assistido
```
Igual ao ensaio, mas vai até o fim: clica em "Protocolar", você digita o PIN, o robô lê o número do processo na tela do recibo, gera o PDF do recibo e manda tudo para o painel. O IURIA recebe o número e a Paula avisa a cliente.

## 4. Automático (depois dos passos ajustados)
```powershell
npm start
```
Fica rodando: consulta a fila a cada 60 s, protocola sozinho e, em qualquer tela inesperada, para, manda o print para o painel e espera nova aprovação. Para deixar permanente, crie uma tarefa no Agendador do Windows que rode `node C:\robo-protocolo\robo.mjs` no logon.

## Regras
- Um protocolo por vez. Nunca tenta duas vezes sozinho.
- Prints de cada passo com erro ficam em `prints\`; só o da falha vai ao painel.
- Senha do painel só em `config.json` (não versionar). PIN do token nunca em arquivo.
- Se o e-SAJ pedir um dado que não está no item (ex.: endereço de um réu), o robô para em vez de inventar.
