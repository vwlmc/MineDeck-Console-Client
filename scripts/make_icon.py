#!/usr/bin/env python3
"""
Builds assets/icon.ico and the tray icons from assets/icon.png (needs Pillow).

Small sizes are stored as classic 32-bit bitmaps and the large ones as PNG,
which is the layout Windows' own icons use and what every version of
Explorer, the taskbar and shortcut dialogs understand.

usage: python3 scripts/make_icon.py
"""
import io
import os
import struct

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), 'assets')
BMP_SIZES = [16, 20, 24, 32, 40, 48, 64]
PNG_SIZES = [128, 256]


def dib(img):
    """32-bit BGRA device-independent bitmap (bottom-up) with its 1-bit AND mask."""
    w, h = img.size
    px = img.load()
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    color = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            color += bytes((b, g, r, a))
    stride = ((w + 31) // 32) * 4
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row
    return header + bytes(color) + bytes(mask)


def main():
    src = Image.open(os.path.join(ASSETS, 'icon.png')).convert('RGBA')
    images = []
    for size in BMP_SIZES + PNG_SIZES:
        img = src.resize((size, size), Image.LANCZOS)
        if size in PNG_SIZES:
            buf = io.BytesIO()
            img.save(buf, format='PNG', optimize=True)
            data = buf.getvalue()
        else:
            data = dib(img)
        images.append((size, data))
    out = bytearray(struct.pack('<HHH', 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for size, data in images:
        dim = 0 if size >= 256 else size
        out += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in images:
        out += data
    with open(os.path.join(ASSETS, 'icon.ico'), 'wb') as f:
        f.write(out)
    print(f'wrote assets/icon.ico ({len(images)} sizes, {len(out)} bytes)')

    # tray icon in the sizes Windows uses at 100%, 150% and 200% display scale
    # (Electron picks the right file by its @-suffix)
    for name, size in (('tray.png', 16), ('tray@1.5x.png', 24), ('tray@2x.png', 32)):
        src.resize((size, size), Image.LANCZOS).save(os.path.join(ASSETS, name), optimize=True)
    print('wrote assets/tray.png, tray@1.5x.png, tray@2x.png')


if __name__ == '__main__':
    main()
