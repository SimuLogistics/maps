# ets2-water

Builds `ets2-water.geojson` and `ets2-countries.geojson` in
`packages/clis/generator/resources/`, the water and country border layers of
`ets2-world.pmtiles`. Both are traced from ETS2's own UI map texture, so
coastlines and borders line up with the roads and buildings in `ets2.pmtiles`.
The real-world `water.geojson` and `countries.geojson` don't line up because
the game's geography is compressed and distorted.

The texture only covers Europe. Everywhere else, the outputs keep
`water.geojson` and `countries.geojson` unchanged. Borders the texture doesn't
draw (Serbia-Kosovo) are taken from `countries.geojson`, shifted by the local
offset to the drawn borders around them.

## Inputs

- `material/ui/map/map0..3.dds` from `base.scs`, converted to PNG. These are
  the four quadrants of the 4096px in-game map. The SimuLogistics tools
  pipeline writes them to `snapshots/ets2/<version>/map/ui-texture/`.
- `def/map_data.sii` from the same game version. It provides `ui_map_center`
  and `ui_map_size`.

## Run

```shell
python3 -m pip install -r scripts/ets2-water/requirements.txt
python3 scripts/ets2-water/build_water.py \
  --tiles <snapshot>/map/ui-texture \
  --map-data <extracted>/def/map_data.sii \
  --water packages/clis/generator/resources/water.geojson \
  --out packages/clis/generator/resources/ets2-water.geojson \
  --countries packages/clis/generator/resources/countries.geojson \
  --countries-out packages/clis/generator/resources/ets2-countries.geojson
npx prettier --write packages/clis/generator/resources/ets2-*.geojson
make out/ets2-world.pmtiles
```

You only need to rerun it when SCS changes the map texture, for example with a
new map DLC. Check the result against ets2.pmtiles: about 2% of road points
should fall on water (bridges, dikes and ferry ramps).
