#!/usr/bin/env python3
"""Gera os cartões de imagem dos anúncios informativos (feed 1080x1080 e stories 1080x1920).

Uso: python3 bot/anuncios/gerar.py   (precisa do Chromium headless; usa o do Playwright se houver)
Os textos seguem o Provimento 205/2021 da OAB: informativos, sem valores e sem promessa de resultado.
"""
import glob, html, os, pathlib, shutil, subprocess, tempfile

AQUI = pathlib.Path(__file__).resolve().parent
CARTOES = [
    {"slug": "01-a-lei-existe", "rotulo": "Informativo · Lei 14.181/2021",
     "titulo": "Existe uma lei para quem não consegue mais pagar as dívidas.",
     "texto": "A Lei do Superendividamento permite reunir todos os credores em uma única negociação na Justiça, preservando o básico da família."},
    {"slug": "02-minimo-existencial", "rotulo": "Informativo · Mínimo existencial",
     "titulo": "Quando as parcelas tomam quase toda a renda.",
     "texto": "A lei protege uma parte da renda para as despesas essenciais, o chamado mínimo existencial. Vale entender como isso funciona no seu caso."},
    {"slug": "03-plano-5-anos", "rotulo": "Informativo · Plano de pagamento",
     "titulo": "Um plano para todas as dívidas, na mesma mesa.",
     "texto": "O consumidor de boa-fé pode pedir ao juiz um plano de até 5 anos para as dívidas de consumo, com todos os credores de uma vez."},
]
CTA = "Tire suas dúvidas pelo WhatsApp"
RODAPE = "AJF Advocacia · Dr. Alessandro José de Freitas · OAB/SP 374.693"
AVISO = "Conteúdo informativo. Não constitui consulta jurídica nem promessa de resultado."

CSS = """
*{box-sizing:border-box;margin:0}
html,body{width:%(w)dpx;height:%(h)dpx;overflow:hidden}
body{background:linear-gradient(160deg,#0B1B33,#132A4A 60%%,#1B3A66);color:#F2F5F9;font-family:"Liberation Sans","DejaVu Sans",Arial,sans-serif;position:relative}
.ring{position:absolute;border:2px solid rgba(255,255,255,.07);border-radius:50%%}
.r1{width:%(r1)dpx;height:%(r1)dpx;right:-%(r1o)dpx;top:-%(r1o)dpx}
.r2{width:%(r2)dpx;height:%(r2)dpx;right:%(r2x)dpx;bottom:-%(r2o)dpx}
.card{position:absolute;inset:0;padding:%(pad)dpx;display:flex;flex-direction:column;justify-content:space-between}
.top{display:flex;justify-content:space-between;align-items:flex-start}
.rotulo{font-size:%(rot)dpx;letter-spacing:.16em;text-transform:uppercase;font-weight:700;color:#D2A24F;margin-top:%(rotm)dpx}
.mark{width:%(mk)dpx;height:%(mk)dpx;border:3px solid #D2A24F;display:grid;place-items:center;font-family:"Bitstream Charter",Georgia,serif;font-size:%(mkf)dpx;color:#D2A24F;letter-spacing:.04em}
h1{font-family:"Bitstream Charter",Georgia,serif;font-weight:400;font-size:%(h1)dpx;line-height:1.08;letter-spacing:-.01em;max-width:%(h1w)dpx;text-wrap:balance}
h1 em{font-style:italic;color:#D2A24F}
p.texto{font-size:%(tx)dpx;line-height:1.4;color:#C9D4E3;max-width:%(txw)dpx;margin-top:%(txm)dpx}
.meio{display:flex;flex-direction:column;gap:0}
.cta{display:inline-flex;align-items:center;gap:18px;background:#A67C2E;color:#1A1200;font-weight:700;font-size:%(cta)dpx;padding:%(ctap)s;border-radius:12px;align-self:flex-start;margin-bottom:%(ctam)dpx}
.cta svg{width:%(ico)dpx;height:%(ico)dpx}
.rodape{border-top:1px solid rgba(255,255,255,.18);padding-top:%(rp)dpx;font-size:%(rf)dpx;color:#B7C3D3;line-height:1.45}
.rodape small{display:block;font-size:%(af)dpx;color:#8E9AAE;margin-top:6px}
"""
TPL = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>%(css)s</style></head><body>
<div class="ring r1"></div><div class="ring r2"></div>
<div class="card">
  <div class="top"><div class="rotulo">%(rotulo)s</div><div class="mark">AJF</div></div>
  <div class="meio"><h1>%(titulo)s</h1><p class="texto">%(texto)s</p></div>
  <div>
    <div class="cta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20l1.2-4.2A8.5 8.5 0 1 1 20 11.5Z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2L9 9.5Z"/></svg>%(cta)s</div>
    <div class="rodape">%(rodape)s<small>%(aviso)s</small></div>
  </div>
</div></body></html>"""

FORMATOS = {
    "feed": dict(w=1080, h=1080, r1=760, r1o=300, r2=520, r2x=120, r2o=260, pad=72, rot=22, rotm=14, mk=84, mkf=30,
                 h1=74, h1w=900, tx=33, txw=860, txm=30, cta=30, ctap="22px 34px", ctam=40, ico=36, rp=22, rf=22, af=18),
    "story": dict(w=1080, h=1920, r1=900, r1o=340, r2=640, r2x=80, r2o=300, pad=96, rot=26, rotm=18, mk=100, mkf=36,
                  h1=96, h1w=900, tx=40, txw=880, txm=40, cta=36, ctap="28px 40px", ctam=56, ico=42, rp=26, rf=26, af=21),
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
                                  texto=html.escape(c["texto"]), cta=html.escape(CTA), rodape=html.escape(RODAPE), aviso=html.escape(AVISO))
                src = pathlib.Path(tmp) / f"{c['slug']}-{fmt}.html"
                src.write_text(page, encoding="utf-8")
                out = AQUI / f"{c['slug']}-{fmt}.png"
                subprocess.run([ch, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                                f"--window-size={dims['w']},{dims['h']}", f"--screenshot={out}", src.as_uri()],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                print("gerado", out.relative_to(AQUI.parent.parent), f"{out.stat().st_size // 1024} KB")

if __name__ == "__main__":
    main()
