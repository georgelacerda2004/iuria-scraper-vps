# Mensagem para Jurisprudências.ai — licença de revenda / preço embedded (B2B2C)

> RASCUNHO para o George revisar e enviar. O Claude NÃO envia.
> Destinatário sugerido: **suporte@jurisprudencias.ai**
> (é o único e-mail publicado pela empresa; consta na doc da API como canal
>  para "dúvidas técnicas e integrações", e também nos Termos e na Política de
>  Privacidade. Não há `comercial@` nem `parcerias@` divulgado — usar este.)

---

**Assunto:** Integração da API de jurisprudência no IURIA (SaaS jurídico) — modelo embedded / revenda B2B2C

Prezados,

Sou George Lacerda, responsável pelo IURIA (https://www.iuria.com.br), um SaaS
jurídico que atende escritórios de advocacia em todo o país. Temos interesse em
integrar a API de jurisprudência de vocês para servir a pesquisa de decisões
diretamente dentro do nosso produto.

O modelo que pretendemos é **embedded / B2B2C**: o IURIA consumiria a API de
vocês sob uma chave central nossa e ofereceria a pesquisa aos escritórios
clientes do IURIA dentro da nossa interface. Nós metrificamos internamente o uso
por escritório (cada cliente é um tenant isolado na nossa plataforma), de modo
que conseguimos reportar volume agregado e por escritório, se necessário.

Gostaríamos de entender as condições para esse tipo de uso:

1. **Permissão do modelo embedded/revenda** — vocês autorizam que o IURIA
   consuma a API sob uma chave central e exponha os resultados aos nossos
   escritórios clientes (revenda/white-label do recurso de pesquisa)? Há
   restrição contratual a esse uso?

2. **Preço / condição comercial** — existe um plano para esse cenário (por
   escritório atendido, por volume de chamadas, ou um plano enterprise com
   franquia maior)? Qual a melhor estrutura para um integrador que cresce em
   número de escritórios?

3. **Limites de rate** — quais os limites de requisições (por dia / por minuto)
   no plano que vocês recomendariam para esse uso, e como funciona o aumento de
   franquia (as "unidades adicionais" que vi na documentação se aplicam a esse
   cenário)?

4. **Cobertura de tribunais** — qual a lista atual de tribunais cobertos pela
   API e a profundidade do acervo (período coberto) por tribunal? Há previsão de
   expansão?

5. **Campos retornados / SLA** — confirmamos pela documentação que a API retorna
   relator, órgão julgador, ementa, data de julgamento e link direto. Há SLA de
   disponibilidade e suporte para integradores?

Fico à disposição para uma call e para assinar NDA, se preferirem tratar valores
fora do e-mail. Nosso objetivo é uma parceria de longo prazo com uma fonte de
jurisprudência confiável e de baixa latência.

Atenciosamente,

George H. B. Lacerda
IURIA — https://www.iuria.com.br
[telefone / WhatsApp]
