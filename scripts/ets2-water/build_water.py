#!/usr/bin/env python3
"""Builds an ETS2-aligned water layer from the game's own UI map texture.

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

Usage:
  python3 build_water.py --tiles <dir with map0..3.png> \
      --map-data <extracted>/def/map_data.sii \
      --water ../../packages/clis/generator/resources/water.geojson \
      --out ../../packages/clis/generator/resources/ets2-water.geojson
"""
import argparse
import json
import re

import cv2
import numpy as np
from PIL import Image
from pyproj import Proj
from shapely.geometry import Polygon, box, mapping, shape
from shapely.ops import unary_union

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

# Light grey (sea) vs dark grey/black (land) in the 8-bit luminance image.
SEA_THRESHOLD = 100
# Country borders are drawn as thin light lines over land; an opening with
# this kernel removes them (and any water narrower than ~4px / ~5 real km).
BORDER_KERNEL = 5
# The texture fades to black over Russia (top-right), sea included, so that
# corner is left to the real-world coastline. In 4096px texture pixels.
FADE_MIN_X, FADE_MAX_Y = 3500, 2400

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
    sx, sy = np.floor(x_uk / 4000), np.floor(y_uk / 4000)
    is_uk = (sx <= -8) & (sy <= -2) & ~((sx == -8) & (sy == -2))
    x = np.where(is_uk, x / UK_SCALE - CALAIS[0] / 2, x)
    y = np.where(is_uk, y / UK_SCALE - CALAIS[1] / 2, y)
    return x + MAP_OFFSET[0], y + MAP_OFFSET[1]


def read_map_data(path):
    text = open(path, encoding='utf-8').read()

    def vec(key):
        m = re.search(rf'{key}\s*:\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)', text)
        if not m:
            raise SystemExit(f'{key} not found in {path}')
        return float(m.group(1)), float(m.group(2))

    return vec('ui_map_center'), vec('ui_map_size')


def load_sea_mask(tiles_dir):
    tiles = [Image.open(f'{tiles_dir}/map{i}.png').convert('L') for i in range(4)]
    n = tiles[0].width
    full = Image.new('L', (2 * n, 2 * n))
    # map0 top-left, map1 bottom-left, map2 top-right, map3 bottom-right.
    for img, pos in zip(tiles, [(0, 0), (0, n), (n, 0), (n, n)]):
        full.paste(img, pos)
    sea = (np.array(full) >= SEA_THRESHOLD).astype(np.uint8)
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (BORDER_KERNEL, BORDER_KERNEL)
    )
    sea = cv2.morphologyEx(sea, cv2.MORPH_OPEN, kernel)
    # Slight blur so bilinear sampling gives smooth sub-pixel coastlines.
    return cv2.GaussianBlur(sea.astype(np.float32), (0, 0), 0.8)


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
    n = sea.shape[0]
    w = size_km[0] * 1000 / GAME_SCALE
    h = size_km[1] * 1000 / GAME_SCALE
    left, top = center[0] - w / 2, center[1] - h / 2

    nx = int(round((LON1 - LON0) / DLON))
    ny = int(round((LAT1 - LAT0) / DLAT))
    water = rasterize_ne_water(ne_features, nx, ny)
    lons = LON0 + (np.arange(nx) + 0.5) * DLON
    for r0 in range(0, ny, 128):
        r1 = min(ny, r0 + 128)
        lats = LAT1 - (np.arange(r0, r1) + 0.5) * DLAT
        lon, lat = np.meshgrid(lons, lats)
        gx, gy = wgs84_to_game(lon, lat)
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
    return water


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


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--tiles', required=True, help='dir with map0..3.png')
    ap.add_argument('--map-data', required=True, help='def/map_data.sii')
    ap.add_argument('--water', required=True, help='real-world water.geojson')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    center, size_km = read_map_data(args.map_data)
    sea = load_sea_mask(args.tiles)
    ne = json.load(open(args.water))
    water = build_water_raster(sea, center, size_km, ne['features'])
    grid = box(LON0 + DLON, LAT0 + DLAT, LON1 - DLON, LAT1 - DLAT)
    inside = vectorize(water).intersection(grid)
    outside = unary_union(
        [shape(f['geometry']).buffer(0) for f in ne['features']]
    ).difference(grid)
    merged = unary_union([inside, outside])

    geometry = json.loads(
        json.dumps(mapping(merged)), parse_float=lambda v: round(float(v), 5)
    )
    out = {
        'type': 'FeatureCollection',
        'name': 'water',
        'features': [{'type': 'Feature', 'properties': {}, 'geometry': geometry}],
    }
    with open(args.out, 'w') as f:
        json.dump(out, f, separators=(',', ':'))


if __name__ == '__main__':
    main()
