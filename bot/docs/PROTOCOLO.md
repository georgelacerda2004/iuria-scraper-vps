# Fila de protocolo — contrato para o robô do PC (eproc TJSP)

Fluxo: `rascunho` (petição gerada) → `pronta` (pacote de PDFs montado pelo servidor) → `aprovada` (toque do advogado no painel, ou automático com `PROTOCOLO_AUTO=on`) → `em_protocolo` (robô pegou) → `protocolada` | `erro`.

Com `PROTOCOLO_AUTO=on` (ligado em 10/10/2026 por ordem do George) o item já nasce `aprovada` assim que o pacote fica pronto: a Paula fecha o caso e o robô protocola na rodada seguinte, sem toque no painel. O botão "Cancelar aprovação" no painel continua valendo para segurar um caso.

Depois do protocolo: a Paula avisa a cliente em até 15 min (número, chave e link do Portal do Cliente) e, se houver `triagem.docs_pendentes`, pede o que falta. Os andamentos (inclusive a liminar) são lidos **uma vez por dia**, às `ANDAMENTOS_HORA` (padrão 18:00 de Brasília): cada movimentação nova é classificada e explicada; liminar deferida gera a entrada após a liminar (Asaas em produção) e o êxito projetado no IURIA.

## 0. O que a fila garante desde 10/10 (pedidos do relatório do Hermes)
- `partes.ativo[]` traz `logradouro`, `numero`, `complemento`, `bairro`, `cidade`, `uf`, `cep` e `sexo` (`sexo_inferido: true` quando deduzido pelo nome: o engine deve registrar no log).
- `jurisdicao` na Capital vem com o **Foro Regional pelo CEP** (consulta à Competência Territorial do TJSP; cai em "São Paulo - Foro Central Cível" se a consulta falhar). Fora da Capital: "Foro de <Cidade>".
- `opcoes.juizo_digital: true` sempre presente.
- `sistema` é `eproc`.
- Réus sem CNPJ vêm com `pendente: true` (o engine deve parar com erro explícito, nunca inventar).

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

Sucesso (o engine do Hermes devolve isto ao final de `--finalizar`):
```json
{ "ok": true, "numero_processo": "4198609-41.2026.8.26.0100", "recibo_base64": "<PDF do recibo, opcional>", "recibo_nome": "recibo.pdf",
  "detalhes": { "chave": "314107778926", "juizo": "45ª Vara Cível - Foro Central Cível", "sistema": "eproc", "partes": "..." } }
```
`detalhes.chave` vira a chave de consulta pública que a Paula manda à cliente; `detalhes.juizo` preenche vara e comarca do processo no IURIA.
Erro (qualquer tela inesperada, CAPTCHA, PIN recusado, campo que não achou):
```json
{ "ok": false, "erro": "texto curto do que aconteceu", "tela_base64": "<PNG da tela>", "detalhes": { "passo": "anexos" } }
```
O servidor também aceita os nomes usados pelo motor do Hermes: `recibo_pdf_base64` no lugar de `recibo_base64` e `print_base64` no lugar de `tela_base64`. `GET /painel/api/fila?status=aprovada` devolve só os itens aprovados (sem o parâmetro vêm `aprovada` e `em_protocolo`).

No sucesso o servidor grava o número no processo do IURIA, guarda o recibo e a Paula avisa a cliente. No erro o item vai para `erro`, o advogado recebe o aviso e decide se aprova de novo.

## 4. Regras do robô
- Um item por vez. Nunca protocolar sem `pegar` ter respondido 200.
- Guardar um print de cada tela em disco local (auditoria) e mandar só o da falha.
- PIN do A3 no Cofre de Credenciais do Windows; nunca em arquivo ou variável de ambiente em texto puro.
- Se o e-SAJ pedir algo que não está no item (ex.: CEP do réu), parar com erro em vez de inventar.
- Testes sem protocolar: usar "salvar rascunho" do e-SAJ e devolver `{ ok: false, erro: "teste: rascunho salvo" }`.
