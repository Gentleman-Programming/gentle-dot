"""Trace the neon lines of the Gentleman rose into SVG centerline paths.

Usage: python -I trace_rose.py <rose.png> <out.svg> [threshold]

The neon outline is isolated by color (bright and pink), reduced to one-pixel
centerlines, split into strokes between junctions, simplified, and written as
smooth SVG paths. Small round blobs (the sparkles) become circles.
"""

import sys

import numpy as np
from PIL import Image
from skimage.measure import approximate_polygon, label, regionprops
from skimage.morphology import closing, disk, remove_small_objects, skeletonize

SRC, OUT = sys.argv[1], sys.argv[2]
THRESHOLD = float(sys.argv[3]) if len(sys.argv) > 3 else 120
MIN_STROKE_PX = 18
SIMPLIFY_PX = 1.1

rgb = np.asarray(Image.open(SRC).convert("RGB")).astype(float)
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
mask = (r > THRESHOLD) & (r - g > 45)
mask = remove_small_objects(mask, max_size=6)

# Sparkles: small, compact blobs that are not part of a line.
sparkles = []
for region in regionprops(label(mask)):
    h = region.bbox[2] - region.bbox[0]
    w = region.bbox[3] - region.bbox[1]
    if region.area <= 260 and max(h, w) <= 22 and min(h, w) >= 0.5 * max(h, w):
        cy, cx = region.centroid
        sparkles.append((cx, cy, max(1.6, (h + w) / 4)))
        mask[region.slice] &= ~region.image

# Bridge the small gaps between glow segments so strokes stay continuous.
skeleton = skeletonize(closing(mask, disk(3)))
pixels = set(zip(*np.nonzero(skeleton)))
OFFSETS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def neighbors(p):
    return [(p[0] + dy, p[1] + dx) for dy, dx in OFFSETS if (p[0] + dy, p[1] + dx) in pixels]


degree = {p: len(neighbors(p)) for p in pixels}
seen = set()
strokes = []


def walk(start, nxt):
    path = [start, nxt]
    seen.add((start, nxt))
    seen.add((nxt, start))
    prev, cur = start, nxt
    while degree[cur] == 2:
        step = [n for n in neighbors(cur) if n != prev]
        if not step or (cur, step[0]) in seen:
            break
        prev, cur = cur, step[0]
        seen.add((prev, cur))
        seen.add((cur, prev))
        path.append(cur)
    return path


for p in pixels:
    if degree[p] != 2:
        for q in neighbors(p):
            if (p, q) not in seen:
                strokes.append(walk(p, q))
for p in pixels:  # closed loops have no endpoints
    if degree[p] == 2:
        for q in neighbors(p):
            if (p, q) not in seen:
                strokes.append(walk(p, q))


def smooth_path(points):
    pts = [(x, y) for y, x in points]
    d = f"M{pts[0][0]:.1f} {pts[0][1]:.1f}"
    if len(pts) == 2:
        return d + f"L{pts[1][0]:.1f} {pts[1][1]:.1f}"
    for i in range(1, len(pts) - 1):
        mx, my = (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2
        d += f"Q{pts[i][0]:.1f} {pts[i][1]:.1f} {mx:.1f} {my:.1f}"
    return d + f"L{pts[-1][0]:.1f} {pts[-1][1]:.1f}"


kept = []
for stroke in strokes:
    if len(stroke) < MIN_STROKE_PX:
        continue
    simplified = approximate_polygon(np.array(stroke, dtype=float), tolerance=SIMPLIFY_PX)
    kept.append((len(stroke), smooth_path(simplified)))
kept.sort(key=lambda item: -item[0])

height, width = mask.shape
with open(OUT, "w") as out:
    out.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}">\n')
    out.write('<g id="rose-lines" fill="none" stroke-linecap="round" stroke-linejoin="round">\n')
    for length, d in kept:
        out.write(f'<path data-length="{length}" d="{d}"/>\n')
    out.write("</g>\n<g id=\"rose-sparkles\">\n")
    for cx, cy, radius in sparkles:
        out.write(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{radius:.1f}"/>\n')
    out.write("</g>\n</svg>\n")

print(f"strokes={len(kept)} sparkles={len(sparkles)} total_px={sum(n for n, _ in kept)}")
