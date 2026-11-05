import { ItemType } from '@truckermudgeon/map/constants';
import type {
  Node,
  Prefab,
  PrefabDescription,
  Road,
  RoadLook,
} from '@truckermudgeon/map/types';
import { describe, expect, test } from 'vitest';
import { hasLoop } from '../clean-roads';
import { motorwayRamps } from '../ramp-types';

const motorway = 'traffic_lane.road.motorway';
const local = 'traffic_lane.road.local';
const looks = new Map<string, RoadLook>([
  // one-way motorway carriageway
  ['hw', { lanesLeft: [], lanesRight: [motorway, motorway] }],
  // a one-way ramp with a local look
  ['ramp', { lanesLeft: [], lanesRight: [local] }],
  ['road', { lanesLeft: [local], lanesRight: [local] }],
]);

/**
 * A chain of roads along x, 100 m each, nodes 1, 2, 3…: `looks[i]` is the
 * look of the road from node i+1 to node i+2. `prefabs` puts prefabs on
 * those nodes, joining them to the roads of its other nodes.
 */
function chain(
  roadLooks: string[],
  prefabs: { token: string; nodes: number[] }[] = [],
) {
  const nodes = new Map<bigint, Node>();
  const roads = new Map<bigint, Road>();
  const node = (n: number) => {
    const uid = BigInt(n);
    if (!nodes.has(uid))
      nodes.set(uid, {
        uid,
        x: n * 100,
        y: 0,
        z: 0,
        rotation: 0,
      } as unknown as Node);
    return uid;
  };
  roadLooks.forEach((look, i) => {
    const uid = BigInt(100 + i);
    roads.set(uid, {
      uid,
      type: ItemType.Road,
      x: 0,
      y: 0,
      dlcGuard: 0,
      roadLookToken: look,
      startNodeUid: node(i + 1),
      endNodeUid: node(i + 2),
      length: 100,
    });
  });
  const prefabMap = new Map<bigint, Prefab>();
  const prefabDescriptions = new Map<string, PrefabDescription>();
  prefabs.forEach((p, i) => {
    const uid = BigInt(1000 + i);
    prefabMap.set(uid, {
      uid,
      type: ItemType.Prefab,
      x: 0,
      y: 0,
      token: p.token,
      nodeUids: p.nodes.map(node),
      originNodeIndex: 0,
    } as unknown as Prefab);
    prefabDescriptions.set(p.token, {
      path: `prefab2/${p.token}.ppd`,
      navCurves: [],
    } as unknown as PrefabDescription);
  });
  return {
    nodes,
    roads,
    roadLooks: looks,
    prefabs: prefabMap,
    prefabDescriptions,
  };
}

describe('motorwayRamps', () => {
  test('takes one-way roads between two motorways for a ramp', () => {
    expect(motorwayRamps(chain(['hw', 'ramp', 'ramp', 'hw']))).toEqual(
      new Set([101n, 102n]),
    );
  });

  test('keeps a ramp reaching a two-way road', () => {
    expect(motorwayRamps(chain(['hw', 'ramp', 'road'])).size).toBe(0);
  });

  test('follows the motorway through a merge prefab', () => {
    // ramp 100 ends at node 2; the prefab on nodes 2 and 3 leads to the motorway
    const data = chain(
      ['ramp', 'hw', 'hw'],
      [{ token: 'merge', nodes: [2, 3] }],
    );
    // no road between nodes 2 and 3: the prefab is there instead
    data.roads.delete(101n);
    expect(motorwayRamps(data)).toEqual(new Set([100n]));
  });

  test('keeps the ring of a roundabout between two ramps', () => {
    // motorway ramp 100 joins the ring at a joint, where ring piece 102
    // leaves and ring piece 105 comes in
    const data = chain(
      ['hw', 'ramp', 'ramp', 'ramp', 'hw', 'ramp'],
      [{ token: 'joint', nodes: [2, 3, 7] }],
    );
    data.roads.delete(101n);
    data.roads.delete(103n);
    expect(motorwayRamps(data).has(102n)).toBe(false);
  });

  test('keeps a run through a roundabout prefab', () => {
    const data = chain(
      ['hw', 'ramp', 'hw'],
      [{ token: 'big_roundabout', nodes: [1, 2] }],
    );
    expect(motorwayRamps(data).size).toBe(0);
  });
});

describe('hasLoop', () => {
  test('finds lanes going round', () => {
    expect(
      hasLoop([{ nextLines: [1] }, { nextLines: [2] }, { nextLines: [0] }]),
    ).toBe(true);
  });

  test('finds none in a crossing', () => {
    expect(
      hasLoop([
        { nextLines: [2, 3] },
        { nextLines: [2] },
        { nextLines: [] },
        { nextLines: [] },
      ]),
    ).toBe(false);
  });
});
