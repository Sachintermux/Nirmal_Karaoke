"""One-off colour remap: neon pink/purple theme -> navy + sky-blue theme.

Run from the repo root:  python scripts/retheme-colors.py
Idempotent enough for a single pass; keep the explicit tables below as the record of the mapping.
Reds (live / record / error) are intentionally left alone.
"""
import colorsys
import glob
import re

FILES = (['css/style.css', 'css/game-invite.css', 'index.html', 'audience.html', 'users.html']
         + glob.glob('js/*.js') + glob.glob('js/workers/*.js'))

PRIMARY = '27a9ff'    # sky blue (was neon pink)
SECONDARY = '2f7cf6'  # deeper blue (was purple)
LIGHT = 'a5d2ff'      # light tint (was light purple)

HEX_MAP = {
    'ff007f': PRIMARY, 'ff3d93': PRIMARY, 'ff0077': PRIMARY, 'ec4899': PRIMARY, 'ff69b4': PRIMARY,
    'a855f7': SECONDARY, '8b5cf6': SECONDARY, '9b51e0': SECONDARY, 'b34bff': SECONDARY,
    'b34dff': SECONDARY, 'aa00ff': SECONDARY,
    'd8b4fe': LIGHT,
    '494454': '3a4558', '4a4357': '3b475c',
}
RGB_MAP = {
    (255, 61, 147): (39, 169, 255), (255, 0, 127): (39, 169, 255), (255, 0, 119): (39, 169, 255),
    (255, 0, 128): (39, 169, 255), (255, 75, 130): (39, 169, 255), (255, 105, 180): (39, 169, 255),
    (168, 85, 247): (47, 124, 246), (139, 92, 246): (47, 124, 246), (179, 75, 255): (47, 124, 246),
    (138, 43, 226): (47, 124, 246),
    (66, 37, 91): (22, 50, 92),
}


def shift_dark_purple(r, g, b):
    """Dark, purple-ish surfaces -> the same lightness in navy."""
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    hd = h * 360
    if 235 <= hd <= 310 and s >= 0.12 and v < 0.33:
        nr, ng, nb = colorsys.hsv_to_rgb(218 / 360, min(1, s * 0.85), v)
        return round(nr * 255), round(ng * 255), round(nb * 255)
    return None


def map_hex(h):
    h = h.lower()
    if h in HEX_MAP:
        return HEX_MAP[h]
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    out = shift_dark_purple(r, g, b)
    return '%02x%02x%02x' % out if out else h


def map_rgb(t):
    if t in RGB_MAP:
        return RGB_MAP[t]
    return shift_dark_purple(*t) or t


HEX_RE = re.compile(r'#([0-9a-fA-F]{6})\b')
RGB_RE = re.compile(r'(rgba?\(\s*)(\d+)(\s*,\s*)(\d+)(\s*,\s*)(\d+)')

total = 0
for path in FILES:
    with open(path, encoding='utf-8', newline='') as fh:
        src = fh.read()
    n = 0

    def hex_sub(m):
        global n
        new = map_hex(m.group(1))
        if new.lower() != m.group(1).lower():
            n += 1
        return '#' + new

    def rgb_sub(m):
        global n
        t = (int(m.group(2)), int(m.group(4)), int(m.group(6)))
        new = map_rgb(t)
        if new != t:
            n += 1
        return f'{m.group(1)}{new[0]}{m.group(3)}{new[1]}{m.group(5)}{new[2]}'

    out = HEX_RE.sub(hex_sub, src)
    out = RGB_RE.sub(rgb_sub, out)
    if out != src:
        with open(path, 'w', encoding='utf-8', newline='') as fh:
            fh.write(out)
        print(f'{n:4d} colours remapped in {path}')
        total += n
print('total', total)
