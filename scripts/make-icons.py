"""Draws the extension icons (blue rounded square with a white truck)."""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'extension', 'icons')
BG = (26, 115, 232)
FG = (255, 255, 255)


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixel(u, v):
    """u, v in 0..1; returns RGBA."""
    if not inside_round_rect(u, v, 0, 0, 1, 1, 0.22):
        return (0, 0, 0, 0)
    trailer = 0.12 <= u <= 0.62 and 0.30 <= v <= 0.64
    cab = 0.65 <= u <= 0.88 and 0.42 <= v <= 0.64 and not (0.70 <= u <= 0.84 and 0.46 <= v <= 0.54)
    wheels = any((u - cx) ** 2 + (v - 0.72) ** 2 <= 0.075 ** 2 for cx in (0.26, 0.48, 0.77))
    return FG + (255,) if (trailer or cab or wheels) else BG + (255,)


def png(size):
    ss = 4  # supersampling for smooth edges
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    p = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size)
                    for i in range(3):
                        acc[i] += p[i] * p[3]
                    acc[3] += p[3]
            a = acc[3] / (ss * ss)
            rgb = [int(acc[i] / acc[3]) if acc[3] else 0 for i in range(3)]
            row += bytes(rgb + [int(a)])
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 48, 128):
        with open(os.path.join(OUT, f'icon{size}.png'), 'wb') as f:
            f.write(png(size))
