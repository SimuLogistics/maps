import { ItemType } from '@truckermudgeon/map/constants';
import type { Node, Road } from '@truckermudgeon/map/types';
import type { GeoJSON } from 'geojson';
import { describe, expect, test } from 'vitest';
import { liftBridges } from '../road-levels';

type P = [number, number];
type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;

const node = (uid: bigint, x: number, y: number, z: number, rotation: number) =>
  ({ uid, x, y, z, rotation }) as unknown as Node;

/** A straight road from (x0, y0) to (x1, y1) at height z, and its feature. */
function straight(uid: bigint, a: P, b: P, z: number) {
  const rotation = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const start = node(uid * 10n, a[0], a[1], z, rotation);
  const end = node(uid * 10n + 1n, b[0], b[1], z, rotation);
  const road: Road = {
    uid,
    type: ItemType.Road,
    x: (a[0] + b[0]) / 2,
    y: (a[1] + b[1]) / 2,
    dlcGuard: 0,
    roadLookToken: 'look',
    startNodeUid: start.uid,
    endNodeUid: end.uid,
    length: Math.hypot(b[0] - a[0], b[1] - a[1]),
  };
  const feature: Feature = {
    type: 'Feature',
    properties: { type: 'road', roadType: 'local' },
    geometry: { type: 'LineString', coordinates: [a, b] },
  };
  return { nodes: [start, end], road, feature };
}

function lift(roads: ReturnType<typeof straight>[]) {
  const features = roads.map(r => r.feature);
  const n = liftBridges(
    features,
    c => c as P[],
    c => c,
    {
      roads: new Map(roads.map(r => [r.road.uid, r.road])),
      nodes: new Map(roads.flatMap(r => r.nodes).map(nd => [nd.uid, nd])),
      prefabs: new Map(),
      prefabDescriptions: new Map(),
    },
  );
  return { n, features };
}

describe('liftBridges', () => {
  test('lifts only the stretch of the upper road over the lower one', () => {
    const { n, features } = lift([
      straight(1n, [-100, 0], [100, 0], 0),
      straight(2n, [0, -100], [0, 100], 8),
    ]);
    expect(n).toBe(1);
    const lifted = features.filter(f => f.properties.level === 1);
    expect(lifted).toHaveLength(1);
    const [from, to] = (lifted[0].geometry as GeoJSON.LineString).coordinates;
    expect(from[1]).toBeCloseTo(-15);
    expect(to[1]).toBeCloseTo(15);
    // the lower road and the rest of the upper one stay on the ground
    expect(features.filter(f => !f.properties.level)).toHaveLength(3);
  });

  test('leaves crossings at the same height on the ground', () => {
    const { n, features } = lift([
      straight(1n, [-100, 0], [100, 0], 0),
      straight(2n, [0, -100], [0, 100], 3),
    ]);
    expect(n).toBe(0);
    expect(features).toHaveLength(2);
  });

  test('puts a bridge over a bridge one level higher', () => {
    const { features } = lift([
      straight(1n, [-100, 0], [100, 0], 0),
      straight(2n, [0, -100], [0, 100], 8),
      straight(3n, [-100, -100], [100, 100], 16),
    ]);
    const levels = features.map(f => Number(f.properties.level ?? 0));
    expect(Math.max(...levels)).toBe(2);
  });
});
