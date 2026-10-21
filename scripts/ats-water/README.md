# ats-water

Builds the ATS base layers, `ats-land`, `ats-water`, `ats-states` and
`ats-countries` (GeoJSON). Land and water are traced from ATS's own UI map
texture so the coast lines up with the roads in `ats.pmtiles`; it reuses the
tracing functions of [`../ets2-water`](../ets2-water/README.md). Borders are
the real-world `states.geojson` and the US borders of `countries.geojson`:
they fall on the texture's own lines (97% of points within one pixel) and
stay straight. They are cut where they cross water.

The outputs only cover the texture (North America). `ats-land` is the outline
of the texture: drawn opaque, it hides any world layer below (for example the
real-world coastline of the ETS2 base layer), so the two games can share one
map with one base layer each.

## Inputs

- `material/ui/map/map0..3.dds` from ATS's `base.scs`, converted to PNG. The
  SimuLogistics tools pipeline writes them to
  `snapshots/ats/<version>/map/ui-texture/`.
- `def/map_data.sii` from the same game version, for `ui_map_size`.

## Run

```shell
python3 -m pip install -r scripts/ats-water/requirements.txt
python3 scripts/ats-water/build_ats_water.py \
  --tiles <snapshot>/map/ui-texture \
  --map-data <extracted>/def/map_data.sii \
  --resources packages/clis/generator/resources \
  --out-dir <dir> \
  --nodes <parser output>/usa-nodes.json
tippecanoe -Z4 -z8 -b 10 -X -o ats-world.pmtiles \
  -L land:<dir>/ats-land.geojson -L water:<dir>/ats-water.geojson \
  -L states:<dir>/ats-states.geojson -L countries:<dir>/ats-countries.geojson
```

`--nodes` is optional and prints the share of road points that fall on water:
about 0.3% for ATS 1.61. The texture is about 1.3 km per pixel, so narrow
water (Galveston Bay, the narrows of Puget Sound) is lost, and some coastal
roads touch the water as they do on the game's own map.

## Placement

The texture is placed exactly as the game places it: centered on
`ui_map_center` (game units) and `ui_map_size` real km wide, at ATS's 1:20
scale (`GAME_SCALE`; ETS2 uses 1:19). Nothing is fitted.
