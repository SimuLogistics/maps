# ets2-water

Builds `packages/clis/generator/resources/ets2-water.geojson`, which is the
water layer for `ets2-world.pmtiles`. It is traced from ETS2's own UI map
texture, so coastlines line up with the roads and buildings in `ets2.pmtiles`.
The real-world `water.geojson` doesn't line up because the game's geography is
compressed and distorted.

The texture only covers Europe. Everywhere else, the output keeps
`water.geojson` unchanged.

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
  --out packages/clis/generator/resources/ets2-water.geojson
npx prettier --write packages/clis/generator/resources/ets2-water.geojson
make out/ets2-world.pmtiles
```

You only need to rerun it when SCS changes the map texture, for example with a
new map DLC. Check the result against ets2.pmtiles: about 2% of road points
should fall on water (bridges, dikes and ferry ramps).
