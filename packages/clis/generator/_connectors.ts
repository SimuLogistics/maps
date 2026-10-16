// One smooth spline per (entry node -> exit node) pair of each prefab, built
// from the world nodes the adjacent roads end on, so it joins them seamlessly.
import { rotateRight } from '@truckermudgeon/base/array';
import { toSplinePoints } from '@truckermudgeon/base/geom';
import { readMapData } from '@truckermudgeon/io';
import { calculateLaneInfo, toMapPosition } from '@truckermudgeon/map/prefabs';
import { fromEts2CoordsToWgs84 } from '@truckermudgeon/map/projections';
import fs from 'fs';

const [inputDir, out] = process.argv.slice(2);
const { nodes, prefabs, prefabDescriptions } = readMapData(inputDir, 'europe', {
  mapDataKeys: ['nodes', 'prefabs', 'prefabDescriptions'],
});
const feats: string[] = [];
let n = 0;
for (const p of prefabs.values()) {
  const desc = prefabDescriptions.get(p.token);
  if (!desc || p.nodeUids.length < 2) continue;
  let laneInfo;
  try { laneInfo = calculateLaneInfo(desc); } catch { continue; }
  const world = rotateRight(p.nodeUids.map(id => nodes.get(id)), p.originNodeIndex);
  // directed pair -> lane start/end points (world), used later to pick the drawn carriageway
  const pairs = new Map<string, { i: number; j: number; s: number[][]; e: number[][] }>();
  for (const [i, lanes] of laneInfo) {
    for (const lane of lanes) {
      for (const br of lane.branches) {
        const j = br.targetNodeIndex;
        if (!world[i] || !world[j] || i === j || br.curvePoints.length < 2) continue;
        const key = `${i}-${j}`;
        let e = pairs.get(key);
        if (!e) pairs.set(key, (e = { i, j, s: [], e: [] }));
        e.s.push(toMapPosition(br.curvePoints[0], p, desc, nodes) as number[]);
        e.e.push(toMapPosition(br.curvePoints[br.curvePoints.length - 1], p, desc, nodes) as number[]);
      }
    }
  }
  const mean = (ps: number[][]) => fromEts2CoordsToWgs84([ps.reduce((a, q) => a + q[0], 0) / ps.length, ps.reduce((a, q) => a + q[1], 0) / ps.length]);
  for (const { i, j, s, e } of pairs.values()) {
    const a = world[i]!, b = world[j]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const fix = (r: number) => (Math.cos(r) * dx + Math.sin(r) * dy >= 0 ? r : r + Math.PI);
    const pts = toSplinePoints(
      { position: [a.x, a.y], rotation: fix(a.rotation) },
      { position: [b.x, b.y], rotation: fix(b.rotation) },
    ).map(q => fromEts2CoordsToWgs84(q as [number, number]));
    feats.push(JSON.stringify({ type: 'Feature', properties: { prefabUid: p.uid.toString(16), token: p.token, i, j, sh: mean(s), eh: mean(e) }, geometry: { type: 'LineString', coordinates: pts } }));
    n++;
  }
}
fs.writeFileSync(out, `{"type":"FeatureCollection","features":[\n${feats.join(',\n')}\n]}`);
console.log('connectors', n);
