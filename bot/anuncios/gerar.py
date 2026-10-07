#!/usr/bin/env python3
"""Gera os cartões de imagem dos anúncios informativos (feed 1080x1080 e stories 1080x1920).

Uso: python3 bot/anuncios/gerar.py   (precisa do Chromium headless; usa o do Playwright se houver)
Os textos seguem o Provimento 205/2021 da OAB: informativos, sem valores e sem promessa de resultado.
"""
import glob, html, os, pathlib, shutil, subprocess, tempfile

AQUI = pathlib.Path(__file__).resolve().parent
CARTOES = [
    {"slug": "01-a-lei-existe", "rotulo": "Você sabia?",
     "titulo": "Existe uma lei para quem não consegue mais pagar as dívidas.",
     "fatos": ["É a Lei 14.181/2021, a Lei do Superendividamento",
               "Todos os credores em uma única negociação",
               "O básico da família fica protegido"]},
    {"slug": "02-minimo-existencial", "rotulo": "Você sabia?",
     "titulo": "Quando as parcelas tomam quase toda a renda, a lei tem resposta.",
     "fatos": ["Uma parte da renda é protegida por lei",
               "É o chamado mínimo existencial",
               "Vale para cartão, empréstimo, crediário e cheque especial"]},
    {"slug": "03-plano-5-anos", "rotulo": "Você sabia?",
     "titulo": "Um plano para todas as dívidas, na mesma mesa.",
     "fatos": ["Até 5 anos para pagar",
               "Todos os credores de uma só vez",
               "Para o consumidor de boa-fé"]},
]
CTA = "Tire suas dúvidas pelo WhatsApp"
RODAPE = "Informativo · Lei 14.181/2021"

CSS = """
*{box-sizing:border-box;margin:0}
html,body{width:%(w)dpx;height:%(h)dpx;overflow:hidden}
body{background:#F6F3EE;color:#101828;font-family:"Liberation Sans","DejaVu Sans",Arial,sans-serif;position:relative}
.faixa{position:absolute;left:0;top:0;bottom:0;width:%(faixa)dpx;background:#132A4A}
.ring{position:absolute;border:2px solid rgba(19,42,74,.08);border-radius:50%%}
.r1{width:%(r1)dpx;height:%(r1)dpx;right:-%(r1o)dpx;top:-%(r1o)dpx}
.card{position:absolute;inset:0;padding:%(pad)dpx %(pad)dpx %(padb)dpx %(padl)dpx;display:flex;flex-direction:column;justify-content:%(just)s}
.rotulo{display:inline-flex;align-items:center;gap:14px;font-size:%(rot)dpx;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:#A67C2E}
.rotulo::before{content:"";width:%(rotl)dpx;height:3px;background:#A67C2E}
h1{font-family:"Bitstream Charter",Georgia,serif;font-weight:400;font-size:%(h1)dpx;line-height:1.08;letter-spacing:-.012em;max-width:%(h1w)dpx;color:#0B1B33;margin-top:%(h1m)dpx;text-wrap:balance}
ul{list-style:none;padding:0;margin:%(ulm)dpx 0 0;display:grid;gap:%(gap)dpx;max-width:%(h1w)dpx}
li{display:grid;grid-template-columns:%(tick)dpx 1fr;gap:20px;align-items:start;font-size:%(tx)dpx;line-height:1.3;color:#344054}
li span.t{width:%(tick)dpx;height:%(tick)dpx;border-radius:50%%;background:#132A4A;display:grid;place-items:center;margin-top:%(tm)dpx}
li span.t svg{width:55%%;height:55%%;stroke:#F4ECDC;stroke-width:3;fill:none}
.base{position:absolute;left:%(padl)dpx;right:%(pad)dpx;bottom:%(pad)dpx;display:flex;flex-direction:%(basedir)s;justify-content:space-between;align-items:%(basealign)s;gap:18px;border-top:1px solid #D5DAE1;padding-top:%(rp)dpx}
.cta{display:inline-flex;align-items:center;gap:16px;white-space:nowrap;background:#132A4A;color:#F2F5F9;font-weight:700;font-size:%(cta)dpx;padding:%(ctap)s;border-radius:999px}
.cta svg{width:%(ico)dpx;height:%(ico)dpx}
.rodape{font-size:%(rf)dpx;color:#667085;letter-spacing:.04em}
"""
TPL = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>%(css)s</style></head><body>
<div class="faixa"></div><div class="ring r1"></div>
<div class="card">
  <div>
    <div class="rotulo">%(rotulo)s</div>
    <h1>%(titulo)s</h1>
    <ul>%(fatos)s</ul>
  </div>
  <div class="base">
    <div class="cta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.2-4.2A8.5 8.5 0 1 1 20 11.5Z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2L9 9.5Z"/></svg>%(cta)s</div>
    <div class="rodape">%(rodape)s</div>
  </div>
</div></body></html>"""
FATO = '<li><span class="t"><svg viewBox="0 0 24 24"><polyline points="4,13 10,19 20,6"/></svg></span><span>%s</span></li>'

FORMATOS = {
    "feed": dict(w=1080, h=1080, faixa=22, r1=700, r1o=280, pad=84, padl=106, padb=220, just="flex-start", basedir="row", basealign="center", rot=24, rotl=44,
                 h1=76, h1w=880, h1m=34, ulm=52, gap=26, tick=44, tm=4, tx=34, cta=28, ctap="20px 30px", ico=32, rp=30, rf=20),
    "story": dict(w=1080, h=1920, faixa=26, r1=860, r1o=320, pad=120, padl=130, padb=340, just="center", basedir="column", basealign="flex-start", rot=28, rotl=52,
                  h1=98, h1w=880, h1m=44, ulm=72, gap=34, tick=52, tm=6, tx=40, cta=34, ctap="26px 38px", ico=38, rp=36, rf=24),
}

def chrome():
    # O headless_shell gera a captura exatamente no tamanho da janela; o Chrome completo desconta a barra da janela.
    for c in sorted(glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell")) + [shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome")] + sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome")):
        if c and os.path.exists(c):
            return c
    raise SystemExit("Chromium não encontrado")

def main():
    ch = chrome()
    with tempfile.TemporaryDirectory() as tmp:
        for c in CARTOES:
            for fmt, dims in FORMATOS.items():
                page = TPL % dict(css=CSS % dims, rotulo=html.escape(c["rotulo"]), titulo=html.escape(c["titulo"]),
                                  fatos="".join(FATO % html.escape(f) for f in c["fatos"]), cta=html.escape(CTA), rodape=html.escape(RODAPE))
                src = pathlib.Path(tmp) / f"{c['slug']}-{fmt}.html"
                src.write_text(page, encoding="utf-8")
                out = AQUI / f"{c['slug']}-{fmt}.png"
                subprocess.run([ch, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                                f"--window-size={dims['w']},{dims['h']}", f"--screenshot={out}", src.as_uri()],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                print("gerado", out.relative_to(AQUI.parent.parent), f"{out.stat().st_size // 1024} KB")

if __name__ == "__main__":
    main()
