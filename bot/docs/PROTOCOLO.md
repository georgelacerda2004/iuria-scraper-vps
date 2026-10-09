# Fila de protocolo — contrato para o robô do PC (semana 2)

Fluxo: `rascunho` (petição gerada) → `pronta` (pacote de PDFs montado pelo servidor) → `aprovada` (toque do advogado no painel) → `em_protocolo` (robô pegou) → `protocolada` | `erro`.

O robô roda no PC do escritório com o certificado A3 do advogado que assina a peça plugado. Ele só age sobre itens `aprovada`. Nunca tenta duas vezes sozinho: em erro, para, manda o print e espera nova aprovação.

Autenticação: header `x-painel: <PAINEL_SENHA>` em todas as chamadas (a mesma senha do painel). Base: `https://superendividamento-bot.onrender.com/painel/api`.

## 1. Pegar a fila
`GET /fila` → `{ itens: [ ... ] }`. Cada item:
```json
{
  "distribuicao_id": "uuid", "status": "aprovada",
  "tribunal": "TJSP", "sistema": "esaj", "grau": "1",
  "classe": "Procedimento de Repactuação de Dívidas (Superendividamento)", "assuntos": [{"nome": "Superendividamento"}],
  "competencia": "Cível", "area": "Consumidor", "jurisdicao": "Foro de Lençóis Paulista", "comarca": null,
  "valor_causa": 8000, "justica_gratuita": true, "tutela_liminar": true, "prioridade": false, "segredo_justica": false,
  "opcoes": { "juizo_digital": true, "intervencao_mp": false, "...": "..." },
  "partes": { "ativo": [{ "tipo_pessoa": "PF", "nome": "...", "cpf": "...", "logradouro": "...", "cep": "..." }],
              "passivo": [{ "tipo_pessoa": "PJ", "nome": "BANCO ...", "cnpj": "90400888000142", "logradouro": "...", "numero": "...", "cidade": "...", "uf": "SP", "cep": "..." }] },
  "cliente": { "nome": "...", "cpf": "...", "cidade": "...", "uf": "SP" },
  "arquivos": [ { "ordem": 1, "nome": "01-peticao-inicial.pdf", "tipo": "Petição inicial", "url": "https://...assinada 1h" }, { "ordem": 2, "nome": "02-rg.pdf", "tipo": "RG", "url": "..." } ],
  "aprovado_em": "2026-10-10T12:00:00Z", "aprovado_por": "Dr. Alessandro"
}
```
Ordem de juntada no e-SAJ: `01` é a petição; os demais são documentos, na ordem numérica.

## 2. Reservar o item (antes de abrir o e-SAJ)
`POST /fila/:distribuicao_id/pegar` body `{ "robo": "pc-escritorio" }` → `200 { ok: true }` ou `409` se outro já pegou / não está aprovado.

## 3. Devolver o resultado
`POST /fila/:distribuicao_id/resultado`

Sucesso:
```json
{ "ok": true, "numero_processo": "1001234-56.2026.8.26.0319", "recibo_base64": "<PDF do recibo do e-SAJ>", "recibo_nome": "recibo.pdf", "detalhes": { "foro": "...", "vara": "..." } }
```
Erro (qualquer tela inesperada, CAPTCHA, PIN recusado, campo que não achou):
```json
{ "ok": false, "erro": "texto curto do que aconteceu", "tela_base64": "<PNG da tela>", "detalhes": { "passo": "anexos" } }
```
No sucesso o servidor grava o número no processo do IURIA, guarda o recibo e a Paula avisa a cliente. No erro o item vai para `erro`, o advogado recebe o aviso e decide se aprova de novo.

## 4. Regras do robô
- Um item por vez. Nunca protocolar sem `pegar` ter respondido 200.
- Guardar um print de cada tela em disco local (auditoria) e mandar só o da falha.
- PIN do A3 no Cofre de Credenciais do Windows; nunca em arquivo ou variável de ambiente em texto puro.
- Se o e-SAJ pedir algo que não está no item (ex.: CEP do réu), parar com erro em vez de inventar.
- Testes sem protocolar: usar "salvar rascunho" do e-SAJ e devolver `{ ok: false, erro: "teste: rascunho salvo" }`.
