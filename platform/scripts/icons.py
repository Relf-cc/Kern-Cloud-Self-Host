#!/usr/bin/env python3
"""Renders Kern Platform's mark to the icon files Tauri bundles.

    python3 scripts/icons.py

Writes src-tauri/icons/: 32x32.png, 128x128.png, 128x128@2x.png, icon.png,
icon.ico and icon.icns.

It draws the shapes rather than parsing assets/icon.svg, so it needs nothing
installed - no cairo, no Pillow, no Node, which matters because this runs on
whatever machine is cutting a release. The shapes here and the ones in the SVG
are the same drawing; the SVG is the one to edit if the mark changes, and the
two must be kept in step.

Each shape is a signed distance field. Pixels are sampled on a grid and
averaged, which gives clean edges on the rounded tile and on the stroke caps
at 32px - the size that actually gets looked at. Shapes carry a bounding box
so most pixels only consult the one or two shapes near them.
"""

import math
import os
import struct
import sys
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "icons")

TILE = (0x16, 0x16, 0x16)
EDGE = (0x35, 0x35, 0x35)
LIGHT = (0xEF, 0xEF, 0xEF)
MID = (0x8F, 0x8F, 0x8F)


class Shape:
    """A distance function, a colour, and where it can possibly be seen."""

    __slots__ = ("distance", "colour", "box")

    def __init__(self, distance, colour, box):
        self.distance = distance
        self.colour = colour
        self.box = box  # (x0, y0, x1, y1), padded by a pixel at 1024


def rounded_rect(x, y, w, h, r, colour):
    cx, cy, hw, hh = x + w / 2, y + h / 2, w / 2 - r, h / 2 - r

    def distance(px, py):
        dx, dy = abs(px - cx) - hw, abs(py - cy) - hh
        return math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - r

    return Shape(distance, colour, (x - 2, y - 2, x + w + 2, y + h + 2))


def capsule(x1, y1, x2, y2, width, colour, scale=1.0, cx=0.0, cy=0.0, dy=0.0):
    """A line with round caps: the SVG's stroke-linecap="round".

    `scale`, `cx`, `cy` and `dy` apply the same transform the SVG puts on the
    K, by moving the line's own endpoints - cheaper and exact, where wrapping
    the distance function would also scale the sampling.
    """
    def place(x, y):
        return (cx + (x - cx) * scale, cy + (y - cy) * scale + dy)

    x1, y1 = place(x1, y1)
    x2, y2 = place(x2, y2)
    r = width * scale / 2
    vx, vy = x2 - x1, y2 - y1
    length2 = vx * vx + vy * vy or 1.0

    def distance(px, py):
        t = ((px - x1) * vx + (py - y1) * vy) / length2
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        return math.hypot(px - (x1 + t * vx), py - (y1 + t * vy)) - r

    box = (min(x1, x2) - r - 2, min(y1, y2) - r - 2, max(x1, x2) + r + 2, max(y1, y2) + r + 2)
    return Shape(distance, colour, box)


def outline(x, y, w, h, r, thickness, colour):
    inner = rounded_rect(x, y, w, h, r, colour)

    def distance(px, py):
        return abs(inner.distance(px, py)) - thickness / 2

    return Shape(distance, colour, (x - thickness, y - thickness, x + w + thickness, y + h + thickness))


# The mark, back to front, in the SVG's 1024x1024 coordinates.
K = dict(scale=0.84, cx=500.0, cy=512.0, dy=-36.0)


def layers():
    return [
        rounded_rect(64, 64, 896, 896, 200, TILE),
        outline(68.5, 68.5, 887, 887, 195.5, 9, EDGE),
        capsule(380, 496.5, 660, 764, 95, MID, **K),
        capsule(396, 495, 684, 248, 95, LIGHT, **K),
        # The stem is a rounded bar in the SVG; as a capsule it is the same
        # shape, inset by its own radius.
        capsule(369.5, 246.5, 369.5, 777.5, 109, LIGHT, **K),
        rounded_rect(300, 838, 424, 58, 29, MID),
    ]


def render(size, samples):
    """Returns PNG scanlines (each already prefixed with filter type 0)."""
    shapes = layers()
    scale = size / 1024.0
    step = 1.0 / (samples * scale)
    half = step / 2
    per_pixel = samples * samples
    rows = bytearray()
    for py in range(size):
        rows.append(0)
        top = py / scale
        bottom = top + 1.0 / scale
        # Shapes that could touch this row at all.
        row_shapes = [s for s in shapes if s.box[1] <= bottom and s.box[3] >= top]
        for px in range(size):
            left = px / scale
            right = left + 1.0 / scale
            near = [s for s in row_shapes if s.box[0] <= right and s.box[2] >= left]
            if not near:
                rows.extend((0, 0, 0, 0))
                continue
            # Accumulated premultiplied colour, and coverage.
            ar = ag = ab = aa = 0.0
            for sy in range(samples):
                y = top + half + sy * step
                for sx in range(samples):
                    x = left + half + sx * step
                    sr = sg = sb = sa = 0.0
                    for shape in near:
                        cover = 0.5 - shape.distance(x, y) * scale
                        if cover <= 0.0:
                            continue
                        if cover > 1.0:
                            cover = 1.0
                        r, g, b = shape.colour
                        keep = 1.0 - cover
                        sr = r * cover + sr * keep
                        sg = g * cover + sg * keep
                        sb = b * cover + sb * keep
                        sa = cover + sa * keep
                    ar += sr
                    ag += sg
                    ab += sb
                    aa += sa
            alpha = aa / per_pixel
            if alpha <= 0.0:
                rows.extend((0, 0, 0, 0))
                continue
            # The accumulation is premultiplied; PNG wants it straight.
            rows.extend((
                min(255, int(ar / per_pixel / alpha + 0.5)),
                min(255, int(ag / per_pixel / alpha + 0.5)),
                min(255, int(ab / per_pixel / alpha + 0.5)),
                min(255, int(alpha * 255 + 0.5)),
            ))
    return bytes(rows)


def png(size, raw):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"".join([b"\x89PNG\r\n\x1a\n", chunk(b"IHDR", ihdr), chunk(b"IDAT", zlib.compress(raw, 9)), chunk(b"IEND", b"")])


def ico(images):
    """A Windows .ico holding PNG entries (Vista and later read these)."""
    out = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    blobs = b""
    for size, data in images:
        dim = 0 if size >= 256 else size  # 0 means 256
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return out + entries + blobs


def icns(images):
    """A macOS .icns holding PNG entries."""
    types = {128: b"ic07", 256: b"ic08", 512: b"ic09"}
    body = b""
    for size, data in images:
        tag = types.get(size)
        if tag:
            body += tag + struct.pack(">I", len(data) + 8) + data
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main():
    os.makedirs(OUT, exist_ok=True)
    # Small sizes get more samples; at 512 the pixels are already smaller than
    # anything in the drawing.
    plan = [(32, 4), (128, 4), (256, 2), (512, 2)]
    rendered = {}
    for size, samples in plan:
        sys.stdout.write("  rendering %dx%d (%dx%d samples)… " % (size, size, samples, samples))
        sys.stdout.flush()
        rendered[size] = png(size, render(size, samples))
        sys.stdout.write("%d bytes\n" % len(rendered[size]))

    files = {
        "32x32.png": rendered[32],
        "128x128.png": rendered[128],
        "128x128@2x.png": rendered[256],
        "icon.png": rendered[512],
        "icon.ico": ico([(32, rendered[32]), (128, rendered[128]), (256, rendered[256])]),
        "icon.icns": icns([(128, rendered[128]), (256, rendered[256]), (512, rendered[512])]),
    }
    for name, data in files.items():
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        print("  wrote icons/%s (%d bytes)" % (name, len(data)))


if __name__ == "__main__":
    main()
