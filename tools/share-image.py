"""Render public/images/share.png, the 1200x630 link-preview image.

Needs Pillow and the two site fonts as variable TTFs from github.com/google/fonts
(ofl/archivo/Archivo[wdth,wght].ttf and ofl/publicsans/PublicSans[wght].ttf):

    python3 tools/share-image.py Archivo.ttf PublicSans.ttf public/images/share.png
"""

import sys
from PIL import Image, ImageDraw, ImageFont

archivo_path, sans_path, out = sys.argv[1:4]
W, H = 1200, 630
GROUND, INK, MUTED, ACCENT, RULE = '#F6F6F3', '#121417', '#4A4F57', '#2141C4', '#D9DAD6'


def archivo(size):
    f = ImageFont.truetype(archivo_path, size)
    f.set_variation_by_axes([800, 112])  # wght, wdth
    return f


def sans(size, weight):
    f = ImageFont.truetype(sans_path, size)
    f.set_variation_by_axes([weight])
    return f


def wrap(draw, text, font, width):
    lines, line = [], ''
    for word in text.split():
        trial = (line + ' ' + word).strip()
        if draw.textlength(trial, font=font) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    lines.append(line)
    return lines


img = Image.new('RGB', (W, H), GROUND)
d = ImageDraw.Draw(img)
x = 72

d.rectangle([0, 0, W, 12], fill=ACCENT)
d.text((x, 64), 'THE INTERVENTION PLEDGE', font=sans(24, 700), fill=MUTED)
d.text((x, 108), "I won't look away.", font=archivo(92), fill=INK)

body = sans(34, 500)
pledge = ('If a woman is being sexually assaulted with my knowledge or in my presence, '
          'I will object and intervene, escalating to calling 911 if necessary.')
y = 250
for line in wrap(d, pledge, body, W - 2 * x):
    d.text((x, y), line, font=body, fill=INK)
    y += 50

d.line([x, H - 120, W - x, H - 120], fill=RULE, width=2)
cta = sans(34, 700)
d.text((x, H - 88), 'Take the pledge', font=cta, fill=ACCENT)
ax = x + d.textlength('Take the pledge', font=cta) + 18
ay = H - 88 + 24
d.line([ax, ay, ax + 30, ay], fill=ACCENT, width=5)
d.line([ax + 17, ay - 13, ax + 31, ay, ax + 17, ay + 13], fill=ACCENT, width=5, joint='curve')

img.save(out, optimize=True)
print(out)
