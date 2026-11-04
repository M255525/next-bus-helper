# 產生 PWA 圖示：藍色站牌邊框＋黑底琥珀 LED 公車
from PIL import Image, ImageDraw
import os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
BLUE, LED, AMBER = (10, 76, 154, 255), (13, 14, 12, 255), (255, 179, 0, 255)
def draw(size, pad=0.0, rounded=True):
    S = size * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded: d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * .22), fill=BLUE)
    else: d.rectangle([0, 0, S, S], fill=BLUE)
    k = 1 - pad * 2
    P = lambda x, y: (S * (pad + x * k), S * (pad + y * k))
    def box(x0, y0, x1, y1, r, fill):
        a, b = P(x0, y0), P(x1, y1)
        d.rounded_rectangle([a[0], a[1], b[0], b[1]], radius=int(S * r * k), fill=fill)
    box(.1, .1, .9, .9, .08, LED)
    # 公車
    box(.22, .24, .78, .68, .06, AMBER)
    box(.28, .31, .47, .46, .015, LED)
    box(.53, .31, .72, .46, .015, LED)
    for x in (.34, .66):
        c = P(x, .68); r = S * .07 * k
        d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=AMBER, outline=LED, width=int(S * .022 * k))
    box(.3, .53, .7, .57, .01, LED)
    return im.resize((size, size), Image.LANCZOS)
os.makedirs(OUT, exist_ok=True)
draw(192).save(os.path.join(OUT, 'icon-192.png'))
draw(512).save(os.path.join(OUT, 'icon-512.png'))
draw(512, pad=.1, rounded=False).save(os.path.join(OUT, 'icon-maskable-512.png'))
