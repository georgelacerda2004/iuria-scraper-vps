#!/usr/bin/env python3
"""Gera o site estático da AJF Advocacia em ./site a partir de site-src/pages/*.html.

Cada fragmento começa com um comentário JSON de metadados:
  <!--meta {"path":"areas/precatorios/","title":"...","description":"...",
            "crumbs":[["Início","/"],["Áreas","/areas/"]],
            "eyebrow":"...","h1":"...","lede":"...","layout":"article|raw"} -->
Layout "article": o fragmento é o conteúdo de <div class="main"> + <aside class="side"> (separados por <!--side-->).
Layout "raw": o fragmento é inserido inteiro entre o header e o rodapé (a home usa esse).
Uso: python3 site-src/build.py
"""
import json, re, pathlib, shutil, html

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "site"
WA_NUM = "5511962417254"          # celular do escritório; trocar pelo chip do robô quando ele entrar no ar
WA_TXT = "(11) 96241-7254"
WA_LINK = f"https://wa.me/{WA_NUM}?text=Ol%C3%A1%2C%20quero%20falar%20sobre%20o%20meu%20caso"
EMAIL = "alessandrojfreitas@hotmail.com"

NAV = [("Início", "/"), ("Áreas de atuação", "/areas/"), ("Precatórios", "/areas/precatorios/"),
       ("Escritório", "/escritorio/"), ("Dúvidas", "/duvidas/"), ("Contato", "/contato/")]

AREAS = [("Precatórios e RPV", "/areas/precatorios/"), ("Superendividamento", "/superendividamento/"),
         ("Direito previdenciário", "/areas/previdenciario/"), ("Direito do trabalho", "/areas/trabalhista/"),
         ("Direito do consumidor", "/areas/consumidor/"), ("Ações coletivas", "/areas/coletivas/")]

def cur(h, current):
    return ' aria-current="page"' if h == current else ''

def header(current):
    links = "".join(f'<a href="{h}"{cur(h, current)}>{t}</a>' for t, h in NAV)
    return f'''<header class="top">
  <div class="wrap">
    <a class="brand" href="/" aria-label="AJF Advocacia, início">
      <span class="mark">AJF</span>
      <span class="name">AJF Advocacia<small>Precatórios · Coletivas · Consumidor</small></span>
    </a>
    <button class="menu-btn" id="menuBtn" aria-expanded="false" aria-controls="menu">Menu</button>
    <nav class="main" id="menu" aria-label="Páginas">{links}</nav>
    <a class="btn dark cta" href="/contato/">Fale com a equipe</a>
  </div>
</header>'''

def contact_block():
    return f'''<div class="contact">
      <div>
        <div class="eyebrow">Contato</div>
        <h2 style="margin:10px 0 12px">Conte o seu caso. Um advogado responde.</h2>
        <p>Atendimento de segunda a sexta, das 9h às 18h. Fora desse horário, o assistente virtual recebe a sua mensagem e organiza as informações para a equipe.</p>
      </div>
      <div class="ways">
        <a class="way" href="{WA_LINK}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.2-4.2A8.5 8.5 0 1 1 20 11.5Z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2L9 9.5Z"/></svg>
          <div><b>WhatsApp</b><span>{WA_TXT}</span></div>
        </a>
        <a class="way" href="mailto:{EMAIL}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
          <div><b>E-mail</b><span>{EMAIL}</span></div>
        </a>
        <div class="way">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
          <div><b>Escritório</b><span>Rua Lombroso, 191, Jd. Tranquilidade · Guarulhos/SP, CEP 07052-010 · atendimento também em Pernambuco e por videoconferência</span></div>
        </div>
      </div>
    </div>'''

FOOTER = '''<footer>
  <div class="wrap">
    <div class="row"><b>AJF Advocacia</b><span>Alessandro José de Freitas, OAB/SP 374.693</span><span>George Henrique Brito Lacerda, OAB/SP 409.102</span></div>
    <p class="legal">Este site tem caráter exclusivamente informativo, em conformidade com o Código de Ética e Disciplina da OAB e com o Provimento 205/2021 do Conselho Federal da OAB. Nenhum conteúdo aqui constitui consulta jurídica nem promessa de resultado. O resultado de cada processo depende da análise do Poder Judiciário e das circunstâncias do caso concreto. O atendimento inicial pode ser realizado por assistente virtual, sob supervisão dos advogados do escritório, e os dados fornecidos são tratados conforme a Lei 13.709/2018 (LGPD).</p>
    <div class="row"><span>© 2026 AJF Advocacia · A.J. Freitas Sociedade Individual de Advocacia · OAB/SP 20278</span><a href="/">Início</a><a href="/areas/">Áreas</a><a href="/escritorio/">Escritório</a><a href="/duvidas/">Dúvidas</a><a href="/contato/">Contato</a></div>
  </div>
</footer>
<script>
  var b=document.getElementById('menuBtn'),m=document.getElementById('menu');
  if(b&&m){b.addEventListener('click',function(){var o=m.classList.toggle('open');b.setAttribute('aria-expanded',o?'true':'false');});}
</script>'''

def side_default(current):
    items = "".join(f'<li><a href="{h}"{cur(h, current)}>{t}</a></li>' for t, h in AREAS)
    return f'''<div class="box dark">
      <h3>Quer uma avaliação do seu caso?</h3>
      <p>Descreva a situação pelo WhatsApp. O assistente virtual organiza as informações e um advogado responde.</p>
      <a class="btn primary" href="{WA_LINK}" target="_blank" rel="noopener">Falar no WhatsApp</a>
    </div>
    <div class="box">
      <h3>Áreas de atuação</h3>
      <ul>{items}</ul>
    </div>'''

def page(meta, body):
    path = meta["path"]
    current = "/" + path if path else "/"
    title = meta["title"]
    desc = html.escape(meta.get("description", ""), quote=True)
    head = f'''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{html.escape(title)}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="https://ajfadvocacia.adv.br{current}">
<meta property="og:title" content="{html.escape(title, quote=True)}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:locale" content="pt_BR">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23132A4A'/%3E%3Ctext x='32' y='42' font-family='Georgia,serif' font-size='26' fill='%23A67C2E' text-anchor='middle'%3EAJF%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&family=Manrope:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
'''
    nav_current = current
    if current.startswith("/areas/") and current != "/areas/":
        nav_current = "/areas/precatorios/" if current == "/areas/precatorios/" else "/areas/"
    parts = [head, header(nav_current)]
    if meta.get("layout") == "raw":
        parts.append(body.replace("<!--CONTACT-->", contact_block()))
    else:
        crumbs = meta.get("crumbs", [["Início", "/"]])
        crumb_html = '<span>›</span>'.join(f'<a href="{h}">{t}</a>' for t, h in crumbs) + f'<span>›</span>{html.escape(meta["h1"])}'
        parts.append(f'''<section class="page-hero">
  <div class="wrap">
    <nav class="crumbs" aria-label="Você está em">{crumb_html}</nav>
    <div class="eyebrow">{meta.get("eyebrow","")}</div>
    <h1>{meta["h1"]}</h1>
    <p class="lede">{meta.get("lede","")}</p>
  </div>
</section>''')
        main, _, side = body.partition("<!--side-->")
        side = side.strip() or side_default(current)
        parts.append(f'''<section class="page">
  <div class="wrap article">
    <div class="main">
{main.strip()}
    </div>
    <aside class="side">
    {side}
    </aside>
  </div>
</section>
<section class="cta-band" id="contato">
  <div class="wrap">
    {contact_block()}
  </div>
</section>''')
    parts += [FOOTER, "</body>\n</html>\n"]
    return "\n".join(parts)

def main():
    (OUT / "assets").mkdir(parents=True, exist_ok=True)
    shutil.copy(ROOT / "site.css", OUT / "assets" / "site.css")
    n = 0
    for frag in sorted((ROOT / "pages").glob("*.html")):
        src = frag.read_text(encoding="utf-8")
        m = re.match(r"\s*<!--meta\s*(\{.*?\})\s*-->", src, re.S)
        if not m:
            raise SystemExit(f"{frag}: sem bloco <!--meta-->")
        meta = json.loads(m.group(1))
        body = src[m.end():]
        out = OUT / meta["path"] / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(page(meta, body), encoding="utf-8")
        n += 1
        print("gerado", out.relative_to(OUT.parent))
    print(f"{n} página(s)")

if __name__ == "__main__":
    main()
