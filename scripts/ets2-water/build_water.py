#!/usr/bin/env python3
"""Builds ETS2-aligned water and country borders from the game's UI map texture.

The base-layer water (resources/water.geojson) is a real-world coastline.
ETS2's geography is compressed and distorted, so that coastline doesn't line
up with the game's roads and buildings. The game draws its own map from a
raster in base.scs (`material/ui/map/map0..3.dds`, four 2048px quadrants of
one 4096px image). This script turns that raster into water polygons in the
same lon/lat space as ets2.pmtiles, and keeps resources/water.geojson
everywhere the texture doesn't cover.

Texture placement comes from def/map_data.sii:
  ui_map_center: texture center, in game coordinates
  ui_map_size:   texture size, in real-world km
Real km convert to game units at a 1:19 scale. That factor isn't in the def
files; it was found by fitting every ets2.pmtiles road point against the
texture (1.8% of road points land on water, mostly bridges and ferry ramps).
Great Britain is the exception: the texture draws it at real-world scale while
UK game content is ~1/0.75 bigger, so UK sectors get their own transform.

Country borders are traced the same way: the texture draws them as thin light
lines over land. Outside the texture, resources/countries.geojson is kept.

Usage:
  python3 build_water.py --tiles <dir with map0..3.png> \
      --map-data <extracted>/def/map_data.sii \
      --water ../../packages/clis/generator/resources/water.geojson \
      --out ../../packages/clis/generator/resources/ets2-water.geojson \
      --countries ../../packages/clis/generator/resources/countries.geojson \
      --countries-out ../../packages/clis/generator/resources/ets2-countries.geojson
"""
import argparse
import json
import re

import cv2
import numpy as np
import shapely
from PIL import Image
from pyproj import Proj
from shapely.geometry import LineString, MultiLineString, Polygon, box, mapping, shape
from shapely.ops import linemerge, unary_union

# Same constants as packages/libs/map/projections.ts (fromWgs84ToEts2Coords).
EARTH_RADIUS = 6_370_997
LENGTH_OF_DEGREE = EARTH_RADIUS * np.pi / 180
ETS2_PROJ = Proj(
    f'+proj=lcc +R={EARTH_RADIUS} +lat_1=37 +lat_2=65 +lat_0=50 +lon_0=15'
)
MAP_OFFSET = (16660, 4150)
MAP_FACTOR = (-0.000171570875, 0.0001729241463)
UK_SCALE = 0.75
CALAIS = (-31100, -5500)

# Real km -> game units (see module docstring).
GAME_SCALE = 19
# The texture draws Great Britain at real-world scale, but UK game content is
# authored ~1/0.75 bigger (see UK_SCALE). For game coords in the UK sectors,
# the texture position is CALAIS + (game - CALAIS) * UK_SCALE + UK_TEXTURE_SHIFT.
# The shift was fitted on UK road points (1.2% of them land on water).
UK_TEXTURE_SHIFT = (-500, 200)

# Light grey (sea) vs dark grey/black (land) in the 8-bit luminance image.
SEA_THRESHOLD = 100
# Country borders are drawn as thin light lines over land; an opening with
# this kernel removes them (and any water narrower than ~4px / ~5 real km).
BORDER_KERNEL = 5
# The texture fades to black over Russia (top-right), sea included, so that
# corner is left to the real-world data. In 4096px texture pixels.
FADE_MIN_X, FADE_MAX_Y = 3300, 2600

# Borders: light lines over land, away from the (antialiased) coast.
BORDER_MIN, BORDER_MAX = 62, 148
BORDER_COAST_GAP = 7
BORDER_MIN_PIXELS = 25
BORDER_SIMPLIFY_PX = 0.8
# Borders the texture doesn't draw: kept from countries.geojson everywhere.
UNDRAWN_BORDERS = {'Serbia-Kosovo'}

# Output raster grid in lon/lat, then vectorized.
LON0, LON1, LAT0, LAT1 = -39.0, 70.0, 22.0, 75.5
DLON, DLAT = 0.005, 0.003
SIMPLIFY_CELLS = 0.6
MIN_AREA_CELLS = 8


def wgs84_to_game(lon, lat):
    ux, uy = ETS2_PROJ(np.asarray(lon), np.asarray(lat))
    x = ux / MAP_FACTOR[1] / LENGTH_OF_DEGREE
    y = uy / MAP_FACTOR[0] / LENGTH_OF_DEGREE
    x_uk = x / UK_SCALE - CALAIS[0] / 2 + MAP_OFFSET[0]
    y_uk = y / UK_SCALE - CALAIS[1] / 2 + MAP_OFFSET[1]
    is_uk = is_uk_sector(x_uk, y_uk)
    x = np.where(is_uk, x / UK_SCALE - CALAIS[0] / 2, x)
    y = np.where(is_uk, y / UK_SCALE - CALAIS[1] / 2, y)
    return x + MAP_OFFSET[0], y + MAP_OFFSET[1], is_uk


def is_uk_sector(x, y):
    sx, sy = np.floor(x / 4000), np.floor(y / 4000)
    return (sx <= -8) & (sy <= -2) & ~((sx == -8) & (sy == -2))


def game_to_wgs84(x, y):
    """Same as fromEts2CoordsToWgs84 in packages/libs/map/projections.ts."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    is_uk = is_uk_sector(x, y)
    x, y = x - MAP_OFFSET[0], y - MAP_OFFSET[1]
    x = np.where(is_uk, (x + CALAIS[0] / 2) * UK_SCALE, x)
    y = np.where(is_uk, (y + CALAIS[1] / 2) * UK_SCALE, y)
    return ETS2_PROJ(
        x * MAP_FACTOR[1] * LENGTH_OF_DEGREE,
        y * MAP_FACTOR[0] * LENGTH_OF_DEGREE,
        inverse=True,
    )


def texture_coords_to_wgs84(tx, ty):
    """Inverse of wgs84_to_texture_coords."""
    ux = CALAIS[0] + (tx - UK_TEXTURE_SHIFT[0] - CALAIS[0]) / UK_SCALE
    uy = CALAIS[1] + (ty - UK_TEXTURE_SHIFT[1] - CALAIS[1]) / UK_SCALE
    is_uk = is_uk_sector(ux, uy)
    return game_to_wgs84(np.where(is_uk, ux, tx), np.where(is_uk, uy, ty))


def wgs84_to_texture_coords(lon, lat):
    """Game coords, except in the UK where the texture is at real scale."""
    x, y, is_uk = wgs84_to_game(lon, lat)
    ux = CALAIS[0] + (x - CALAIS[0]) * UK_SCALE + UK_TEXTURE_SHIFT[0]
    uy = CALAIS[1] + (y - CALAIS[1]) * UK_SCALE + UK_TEXTURE_SHIFT[1]
    return np.where(is_uk, ux, x), np.where(is_uk, uy, y)


def read_map_data(path):
    text = open(path, encoding='utf-8').read()

    def vec(key):
        m = re.search(rf'{key}\s*:\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)', text)
        if not m:
            raise SystemExit(f'{key} not found in {path}')
        return float(m.group(1)), float(m.group(2))

    return vec('ui_map_center'), vec('ui_map_size')


def load_texture(tiles_dir):
    tiles = [Image.open(f'{tiles_dir}/map{i}.png').convert('L') for i in range(4)]
    n = tiles[0].width
    full = Image.new('L', (2 * n, 2 * n))
    # map0 top-left, map1 bottom-left, map2 top-right, map3 bottom-right.
    for img, pos in zip(tiles, [(0, 0), (0, n), (n, 0), (n, n)]):
        full.paste(img, pos)
    return np.array(full)


def sea_mask(tex):
    sea = (tex >= SEA_THRESHOLD).astype(np.uint8)
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (BORDER_KERNEL, BORDER_KERNEL)
    )
    return cv2.morphologyEx(sea, cv2.MORPH_OPEN, kernel)


def fade_zone(n):
    yy, xx = np.mgrid[0:n, 0:n]
    return (xx > FADE_MIN_X * n / 4096) & (yy < FADE_MAX_Y * n / 4096)


def rasterize_ne_water(features, nx, ny):
    mask = np.zeros((ny, nx), np.uint8)

    def to_px(ring):
        a = np.asarray(ring)
        return np.stack(
            [(a[:, 0] - LON0) / DLON, (LAT1 - a[:, 1]) / DLAT], 1
        ).round().astype(np.int32)

    for f in features:
        g = f['geometry']
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        for p in polys:
            cv2.fillPoly(mask, [to_px(p[0])], 1)
            for hole in p[1:]:
                cv2.fillPoly(mask, [to_px(hole)], 0)
    return mask


def build_water_raster(sea, center, size_km, ne_features):
    """Returns (water, inside): lon/lat grids, inside = covered by the texture."""
    n = sea.shape[0]
    # Slight blur so bilinear sampling gives smooth sub-pixel coastlines.
    sea = cv2.GaussianBlur(sea.astype(np.float32), (0, 0), 0.8)
    w = size_km[0] * 1000 / GAME_SCALE
    h = size_km[1] * 1000 / GAME_SCALE
    left, top = center[0] - w / 2, center[1] - h / 2

    nx = int(round((LON1 - LON0) / DLON))
    ny = int(round((LAT1 - LAT0) / DLAT))
    water = rasterize_ne_water(ne_features, nx, ny)
    inside = np.zeros_like(water)
    lons = LON0 + (np.arange(nx) + 0.5) * DLON
    for r0 in range(0, ny, 128):
        r1 = min(ny, r0 + 128)
        lats = LAT1 - (np.arange(r0, r1) + 0.5) * DLAT
        lon, lat = np.meshgrid(lons, lats)
        gx, gy = wgs84_to_texture_coords(lon, lat)
        fx = (gx - left) / w * n - 0.5
        fy = (gy - top) / h * n - 0.5
        px, py = np.floor(fx).astype(np.int64), np.floor(fy).astype(np.int64)
        ok = (px >= 1) & (px < n - 1) & (py >= 1) & (py < n - 1)
        ok &= ~((px > FADE_MIN_X * n / 4096) & (py < FADE_MAX_Y * n / 4096))
        x, y = px[ok], py[ok]
        ax, ay = fx[ok] - x, fy[ok] - y
        v = (
            sea[y, x] * (1 - ax) * (1 - ay)
            + sea[y, x + 1] * ax * (1 - ay)
            + sea[y + 1, x] * (1 - ax) * ay
            + sea[y + 1, x + 1] * ax * ay
        )
        block = water[r0:r1]
        block[ok] = v >= 0.5
        inside[r0:r1] = ok
    return water, inside


def vectorize(water):
    contours, hierarchy = cv2.findContours(
        water, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE
    )
    hierarchy = hierarchy[0]

    def to_lonlat(c):
        c = c.reshape(-1, 2).astype(float)
        return [(LON0 + (x + 0.5) * DLON, LAT1 - (y + 0.5) * DLAT) for x, y in c]

    def ring(c):
        if cv2.contourArea(c) < MIN_AREA_CELLS:
            return None
        r = cv2.approxPolyDP(c, SIMPLIFY_CELLS, True)
        return to_lonlat(r) if len(r) >= 3 else None

    polys = []
    for i, c in enumerate(contours):
        if hierarchy[i][3] != -1:
            continue
        outer = ring(c)
        if outer is None:
            continue
        holes = []
        j = hierarchy[i][2]
        while j != -1:
            h = ring(contours[j])
            if h is not None:
                holes.append(h)
            j = hierarchy[j][0]
        p = Polygon(outer, holes)
        polys.append(p if p.is_valid else p.buffer(0))
    return unary_union(polys)


def thin(img):
    """Zhang-Suen thinning down to 1px-wide 8-connected lines."""
    img = img.astype(np.uint8)
    while True:
        changed = False
        for step in (0, 1):
            P = np.pad(img, 1)
            p2, p3, p4 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:]
            p5, p6, p7 = P[2:, 2:], P[2:, 1:-1], P[2:, :-2]
            p8, p9 = P[1:-1, :-2], P[:-2, :-2]
            ring = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            b = sum(n.astype(int) for n in ring[:8])
            a = sum(((ring[k] == 0) & (ring[k + 1] == 1)).astype(int) for k in range(8))
            if step == 0:
                c = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                c = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            rm = (img == 1) & (b >= 2) & (b <= 6) & (a == 1) & c
            if rm.any():
                img[rm] = 0
                changed = True
        if not changed:
            return img


def trace_skeleton(skel):
    """Splits a 1px skeleton into pixel paths between junctions/ends."""
    pix = set(zip(*np.nonzero(skel)))
    offsets = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]

    def nbrs(p):
        y, x = p
        out = []
        for dy, dx in offsets:
            q = (y + dy, x + dx)
            if q not in pix:
                continue
            # Skip diagonals when a 4-neighbour already links the two pixels,
            # otherwise every staircase step looks like a junction.
            if dy and dx and ((y + dy, x) in pix or (y, x + dx) in pix):
                continue
            out.append(q)
        return out

    adj = {p: nbrs(p) for p in pix}
    nodes = {p for p, n in adj.items() if len(n) != 2}
    seen = set()

    def walk(start, nxt, stop_at_nodes):
        path, prev, cur = [start, nxt], start, nxt
        seen.add(frozenset((start, nxt)))
        while not (stop_at_nodes and cur in nodes):
            cand = [q for q in adj[cur] if q != prev and frozenset((cur, q)) not in seen]
            if not cand:
                break
            seen.add(frozenset((cur, cand[0])))
            prev, cur = cur, cand[0]
            path.append(cur)
        return path

    paths = []
    for s in sorted(nodes):
        for q in adj[s]:
            if frozenset((s, q)) not in seen:
                paths.append(walk(s, q, True))
    # Closed loops have no junction to start from.
    for s in sorted(pix):
        for q in adj[s]:
            if frozenset((s, q)) not in seen:
                paths.append(walk(s, q, False))
    return paths


def chaikin(c):
    if len(c) < 3:
        return c
    q = 0.75 * c[:-1] + 0.25 * c[1:]
    r = 0.25 * c[:-1] + 0.75 * c[1:]
    out = np.empty((2 * len(q), 2))
    out[0::2], out[1::2] = q, r
    return np.vstack([c[:1], out, c[-1:]])


def extend_to_coast(c, sea):
    """Border lines stop up to BORDER_COAST_GAP px short of the sea (the coast
    is antialiased, so it can't be told apart from a border there). Joins each
    end to the nearest sea pixel ahead of it, if there is one close enough."""
    n = sea.shape[0]
    r = 2 * BORDER_COAST_GAP
    oy, ox = np.mgrid[-r:r + 1, -r:r + 1]

    def reach(end, prev):
        x, y = np.round(end).astype(int)
        if not (r <= x < n - r and r <= y < n - r):
            return None
        win = sea[y - r:y + r + 1, x - r:x + r + 1].astype(bool)
        ahead = (ox * (end - prev)[0] + oy * (end - prev)[1]) > 0
        dist = np.hypot(ox, oy)
        ok = win & ahead & (dist <= r)
        if not ok.any():
            return None
        k = np.argmin(np.where(ok, dist, np.inf))
        return np.array([x + ox.flat[k], y + oy.flat[k]], float)

    if len(c) < 2:
        return c
    back = min(len(c) - 1, 6)
    head = reach(c[0], c[back])
    tail = reach(c[-1], c[-1 - back])
    parts = ([head[None]] if head is not None else []) + [c] + (
        [tail[None]] if tail is not None else []
    )
    return np.vstack(parts)


def extract_borders(tex, sea, center, size_km):
    """Country border lines drawn on the texture, in lon/lat."""
    n = tex.shape[0]
    near_sea = cv2.dilate(
        sea,
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (BORDER_COAST_GAP, BORDER_COAST_GAP)
        ),
    )
    mask = (tex >= BORDER_MIN) & (tex <= BORDER_MAX) & (near_sea == 0)
    mask = (mask & ~fade_zone(n)).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    skel = thin(mask)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(skel, connectivity=8)
    keep = np.zeros(count, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= BORDER_MIN_PIXELS
    skel = keep[labels].astype(np.uint8)

    paths = [[(x, y) for y, x in p] for p in trace_skeleton(skel)]
    merged = linemerge(MultiLineString(paths))
    w = size_km[0] * 1000 / GAME_SCALE
    h = size_km[1] * 1000 / GAME_SCALE
    lines = []
    for g in getattr(merged, 'geoms', [merged]):
        c = chaikin(np.array(g.simplify(BORDER_SIMPLIFY_PX).coords))
        c = extend_to_coast(c, sea)
        tx = (c[:, 0] + 0.5) / n * w + center[0] - w / 2
        ty = (c[:, 1] + 0.5) / n * h + center[1] - h / 2
        lon, lat = texture_coords_to_wgs84(tx, ty)
        lines.append(LineString(np.stack([lon, lat], 1)))
    return lines


def align_to_drawn(g, real_lines, drawn, radius=1.5):
    """Shifts a real-world border by the local offset between the real-world
    borders around it and the ones drawn on the texture."""
    area = g.buffer(radius)
    ref = unary_union([r.intersection(area) for r in real_lines]).difference(
        g.buffer(0.05)
    )
    target = unary_union([d.intersection(area) for d in drawn])
    if ref.is_empty or target.is_empty:
        return g
    pts = np.array([
        p for line in getattr(ref, 'geoms', [ref])
        for p in line.segmentize(0.01).coords
    ])
    best = (np.inf, 0.0, 0.0)
    for step in (0.05, 0.01, 0.002):
        _, bx, by = best
        for dx in bx + step * np.arange(-10, 11):
            for dy in by + step * np.arange(-10, 11):
                d = shapely.distance(shapely.points(pts + (dx, dy)), target)
                cost = np.mean(np.minimum(d, 0.2))
                if cost < best[0]:
                    best = (cost, dx, dy)
    return shapely.transform(g, lambda c: c + best[1:])


def rounded(geometry):
    return json.loads(
        json.dumps(mapping(geometry)), parse_float=lambda v: round(float(v), 5)
    )


def write_collection(path, name, features):
    out = {'type': 'FeatureCollection', 'name': name, 'features': features}
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--tiles', required=True, help='dir with map0..3.png')
    ap.add_argument('--map-data', required=True, help='def/map_data.sii')
    ap.add_argument('--water', required=True, help='real-world water.geojson')
    ap.add_argument('--out', required=True)
    ap.add_argument('--countries', help='real-world countries.geojson')
    ap.add_argument('--countries-out')
    args = ap.parse_args()

    center, size_km = read_map_data(args.map_data)
    tex = load_texture(args.tiles)
    sea = sea_mask(tex)
    ne = json.load(open(args.water))
    water, inside = build_water_raster(sea, center, size_km, ne['features'])
    grid = box(LON0 + DLON, LAT0 + DLAT, LON1 - DLON, LAT1 - DLAT)
    outside = unary_union(
        [shape(f['geometry']).buffer(0) for f in ne['features']]
    ).difference(grid)
    merged = unary_union([vectorize(water).intersection(grid), outside])
    write_collection(
        args.out,
        'water',
        [{'type': 'Feature', 'properties': {}, 'geometry': rounded(merged)}],
    )

    if not args.countries:
        return
    coverage = vectorize(inside)
    drawn = extract_borders(tex, sea, center, size_km)
    real = [
        (f['properties'].get('name'), shape(f['geometry']))
        for f in json.load(open(args.countries))['features']
    ]
    features = []
    for name, g in real:
        if name in UNDRAWN_BORDERS:
            g = align_to_drawn(g, [r for _, r in real], drawn)
        else:
            g = g.difference(coverage)
        if not g.is_empty:
            features.append(
                {'type': 'Feature', 'properties': {'name': name}, 'geometry': rounded(g)}
            )
    for line in drawn:
        features.append(
            {'type': 'Feature', 'properties': {'name': None}, 'geometry': rounded(line)}
        )
    write_collection(args.countries_out, 'countries', features)


if __name__ == '__main__':
    main()
