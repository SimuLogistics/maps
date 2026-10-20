#!/usr/bin/env python3
"""Builds the ATS base layers (land, water, state and country borders) from the game's UI map texture.

Same approach as ../ets2-water/build_water.py, whose tracing functions are
reused: the game draws its own map from a raster in base.scs
(`material/ui/map/map0..3.dds`, four 2048px quadrants of one 4096px image).
This script turns that raster into polygons and lines in the same lon/lat
space as ats.pmtiles.

Differences with ETS2:
- ATS projection (fromAtsCoordsToWgs84 in packages/libs/map/projections.ts),
  no UK case, no faded corner.
- Real km convert to game units at ATS's 1:20 scale (ETS2: 1:19). With
  def/map_data.sii's ui_map_center and ui_map_size, that is exactly how the
  game places the texture: nothing is fitted.
- State borders are light lines (~2px) as bright as the sea: the sea is the
  light area after a 7px opening, minus the spots left at line junctions.
- Borders are not traced: the real-world ones (states.geojson, the US borders
  of countries.geojson) fall on the texture's lines (97% of points within one
  pixel) and are straight. They are clipped to the texture and cut where they
  cross water.
- Outputs only cover the texture: `land` is its outline (drawn opaque over
  any world layer below), then `water`, `states` and `countries`.

Usage:
  python3 build_ats_water.py --tiles <snapshot>/map/ui-texture \
      --map-data <extracted>/def/map_data.sii \
      --resources ../../packages/clis/generator/resources \
      --out-dir <dir> [--nodes <parser output>/usa-nodes.json]
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np
from pyproj import Proj
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ets2-water')
)
import build_water as bw  # noqa: E402

# Same constants as packages/libs/map/projections.ts (fromAtsCoordsToWgs84).
ATS_PROJ = Proj(
    f'+proj=lcc +R={bw.EARTH_RADIUS} +lat_1=33 +lat_2=45 +lat_0=39 +lon_0=-96'
)
MAP_FACTOR = (-0.00017706234, 0.000176689948)

# Real km -> game units (ATS world scale).
GAME_SCALE = 20

OPEN_PX = 7
# ~250 km²: smaller lakes go away with the spots left at border junctions.
MIN_SEA_PX = 150


def game_to_wgs84(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    return ATS_PROJ(
        x * MAP_FACTOR[1] * bw.LENGTH_OF_DEGREE,
        y * MAP_FACTOR[0] * bw.LENGTH_OF_DEGREE,
        inverse=True,
    )


def wgs84_to_game(lon, lat):
    ux, uy = ATS_PROJ(np.asarray(lon), np.asarray(lat))
    return ux / MAP_FACTOR[1] / bw.LENGTH_OF_DEGREE, uy / MAP_FACTOR[0] / bw.LENGTH_OF_DEGREE


def sea_mask(tex):
    light = (tex >= bw.SEA_THRESHOLD).astype(np.uint8)
    sea = cv2.morphologyEx(
        light,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (OPEN_PX, OPEN_PX)),
    )
    _, labels, stats, _ = cv2.connectedComponentsWithStats(sea, connectivity=8)
    keep = stats[:, cv2.CC_STAT_AREA] >= MIN_SEA_PX
    keep[0] = False
    return keep[labels].astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--tiles', required=True, help='dir with map0..3.png')
    ap.add_argument('--map-data', required=True, help='def/map_data.sii (ui_map_center, ui_map_size)')
    ap.add_argument(
        '--resources', required=True, help='dir with real-world states.geojson and countries.geojson'
    )
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--nodes', help='usa-nodes.json from the parser: report road points on water')
    args = ap.parse_args()

    center, size_km = bw.read_map_data(args.map_data)
    tex = bw.load_texture(args.tiles)
    sea = sea_mask(tex)

    bw.GAME_SCALE = GAME_SCALE
    bw.wgs84_to_texture_coords = wgs84_to_game
    bw.texture_coords_to_wgs84 = game_to_wgs84
    bw.FADE_MIN_X, bw.FADE_MAX_Y = 10**9, -1

    w = size_km[0] * 1000 / GAME_SCALE
    h = size_km[1] * 1000 / GAME_SCALE
    s = np.linspace(0, 1, 400)
    left, top = center[0] - w / 2, center[1] - h / 2
    edge = np.concatenate([
        np.stack([left + s * w, np.full_like(s, top)], 1),
        np.stack([np.full_like(s, left + w), top + s * h], 1),
        np.stack([left + (1 - s) * w, np.full_like(s, top + h)], 1),
        np.stack([np.full_like(s, left), top + (1 - s) * h], 1),
    ])
    extent = Polygon(np.stack(game_to_wgs84(edge[:, 0], edge[:, 1]), 1)).buffer(0)
    b = extent.bounds
    bw.LON0, bw.LAT0 = np.floor(b[0]) - 0.5, np.floor(b[1]) - 0.5
    bw.LON1, bw.LAT1 = np.ceil(b[2]) + 0.5, np.ceil(b[3]) + 0.5

    water, _ = bw.build_water_raster(sea, center, size_km, [])
    water_poly = bw.vectorize(water).intersection(extent)

    def borders(name, keep=lambda props: True):
        features = json.load(open(os.path.join(args.resources, name)))['features']
        lines = unary_union([shape(f['geometry']) for f in features if keep(f['properties'])])
        return lines.intersection(extent).difference(water_poly)

    states = borders('states.geojson')
    countries = borders(
        'countries.geojson',
        lambda props: 'United States of America' in (props.get('name') or ''),
    )

    def feat(g):
        return {'type': 'Feature', 'properties': {}, 'geometry': bw.rounded(g)}

    os.makedirs(args.out_dir, exist_ok=True)

    def out(name):
        return os.path.join(args.out_dir, f'ats-{name}.geojson')

    bw.write_collection(out('land'), 'land', [feat(extent)])
    bw.write_collection(out('water'), 'water', [feat(water_poly)])
    bw.write_collection(out('states'), 'states', [feat(states)])
    bw.write_collection(out('countries'), 'countries', [feat(countries)])
    print(
        f'{len(getattr(water_poly, "geoms", [water_poly]))} water polygons, '
        f'{len(getattr(states, "geoms", [states]))} state border lines, '
        f'{len(getattr(countries, "geoms", [countries]))} country border lines'
    )

    if args.nodes:
        xy = np.array([(n['x'], n['y']) for n in json.load(open(args.nodes))], float)
        lon, lat = game_to_wgs84(xy[:, 0], xy[:, 1])
        cx = ((lon - bw.LON0) / bw.DLON).astype(int)
        cy = ((bw.LAT1 - lat) / bw.DLAT).astype(int)
        print(f'{100 * water[cy, cx].mean():.2f}% of road points on water')


if __name__ == '__main__':
    main()
