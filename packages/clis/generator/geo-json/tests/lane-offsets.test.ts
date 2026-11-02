import { ItemType } from '@truckermudgeon/map/constants';
import type {
  Node,
  Prefab,
  PrefabDescription,
  Road,
  RoadLook,
} from '@truckermudgeon/map/types';
import { describe, expect, test } from 'vitest';
import { measureLookLaneOffsets } from '../lane-offsets';

type Desc = PrefabDescription;
type Curve = Desc['navCurves'][number];

const curveEnd = (x: number, y: number, rotation: number) => ({
  x,
  y,
  z: 0,
  rotation,
  rotationQuat: [0, 0, 0, 1] as [number, number, number, number],
});

/**
 * A prefab ending at (0, 0), west of it, whose node faces east. Its lanes
 * reach the node at `forward` (driving east, out of the prefab) and
 * `backward` (driving west, into it), as y offsets.
 */
function prefabDesc(forward: number[], backward: number[]): Desc {
  const curve = (
    start: ReturnType<typeof curveEnd>,
    end: ReturnType<typeof curveEnd>,
  ): Curve => ({
    navNodeIndex: 0,
    start,
    end,
    nextLines: [],
    prevLines: [],
    semaphoreId: undefined,
    trafficRule: undefined,
  });
  const navCurves = [
    ...forward.map(y => curve(curveEnd(-50, y, 0), curveEnd(0, y, 0))),
    ...backward.map(y =>
      curve(curveEnd(0, y, Math.PI), curveEnd(-50, y, Math.PI)),
    ),
  ];
  return {
    nodes: [
      {
        x: 0,
        y: 0,
        z: 0,
        rotation: 0,
        rotationDir: [1, 0, 0],
        inputLanes: backward.map((_, i) => forward.length + i),
        outputLanes: forward.map((_, i) => i),
      },
    ],
    navCurves,
    mapPoints: [],
    spawnPoints: [],
    triggerPoints: [],
    navNodes: [],
    signs: [],
  } as unknown as Desc;
}

const node = (uid: bigint, x: number, y: number): Node =>
  ({ uid, x, y, z: 0, rotation: 0 }) as unknown as Node;

const motorway = 'traffic_lane.road.motorway';
const look: RoadLook = {
  lanesLeft: [motorway, motorway],
  lanesRight: [motorway, motorway],
  offset: 2,
};

/** Roads of `look` going east from prefabs, one per lane layout, 1 km apart. */
function mapData(layouts: [string, number[], number[]][]) {
  const nodes = new Map<bigint, Node>();
  const roads = new Map<bigint, Road>();
  const prefabs = new Map<bigint, Prefab>();
  const prefabDescriptions = new Map<string, Desc>();
  layouts.forEach(([token, forward, backward], i) => {
    const y = i * 1000;
    const start = BigInt(i * 10 + 1);
    const end = BigInt(i * 10 + 2);
    // toMapPosition moves the description's lanes onto the start node.
    nodes.set(start, node(start, 0, y));
    nodes.set(end, node(end, 100, y));
    roads.set(BigInt(i * 10 + 3), {
      uid: BigInt(i * 10 + 3),
      type: ItemType.Road,
      x: 50,
      y,
      dlcGuard: 0,
      roadLookToken: 'hw',
      startNodeUid: start,
      endNodeUid: end,
      length: 100,
    });
    prefabs.set(BigInt(i * 10 + 4), {
      uid: BigInt(i * 10 + 4),
      type: ItemType.Prefab,
      x: -25,
      y,
      token,
      nodeUids: [start],
      originNodeIndex: 0,
    } as unknown as Prefab);
    prefabDescriptions.set(token, prefabDesc(forward, backward));
  });
  return {
    nodes,
    roads,
    prefabs,
    prefabDescriptions,
    roadLooks: new Map<string, RoadLook>([['hw', look]]),
  };
}

// right-hand traffic: driving east, the forward lanes are south (+y).
const rht: [number[], number[]] = [
  [4.25, 8.75],
  [-4.25, -8.75],
];

describe('measureLookLaneOffsets', () => {
  test('measures carriageway centers, median and lane width', () => {
    const { looks, leftHandRoads } = measureLookLaneOffsets(
      mapData([
        ['a', ...rht],
        ['b', ...rht],
        ['c', ...rht],
      ]),
    );
    expect(looks.get('hw')).toEqual({
      forward: -6.5,
      backward: 6.5,
      median: 4,
      laneWidth: 4.5,
      samples: 3,
      agreement: 1,
    });
    expect(leftHandRoads.size).toBe(0);
  });

  test('mirrors left-hand traffic samples', () => {
    const { looks, leftHandRoads } = measureLookLaneOffsets(
      mapData([
        ['a', ...rht],
        ['b', ...rht],
        ['uk', [-4.25, -8.75], [4.25, 8.75]],
      ]),
      { minLeftHandRoads: 1 },
    );
    expect(looks.get('hw')?.forward).toBe(-6.5);
    expect(looks.get('hw')?.agreement).toBe(1);
    expect([...leftHandRoads]).toEqual([23n]);
  });

  test('keeps right-hand traffic on a few odd left-hand roads', () => {
    const { leftHandRoads } = measureLookLaneOffsets(
      mapData([
        ['a', ...rht],
        ['b', ...rht],
        ['uk', [-4.25, -8.75], [4.25, 8.75]],
      ]),
    );
    expect(leftHandRoads.size).toBe(0);
  });

  test('measures one-way looks, on the side of the roads around them', () => {
    const data = mapData([
      ['a', [4.25, 8.75], []],
      ['b', [4.25, 8.75], []],
      ['c', [4.25, 8.75], []],
    ]);
    data.roadLooks.set('hw', {
      lanesLeft: [],
      lanesRight: [motorway, motorway],
    });
    const { looks } = measureLookLaneOffsets(data);
    expect(looks.get('hw')).toMatchObject({
      forward: -6.5,
      backward: -6.5,
      median: 0,
    });
  });

  test('drops looks with too few samples or too little agreement', () => {
    expect(
      measureLookLaneOffsets(
        mapData([
          ['a', ...rht],
          ['b', ...rht],
        ]),
      ).looks.has('hw'),
    ).toBe(false);
    expect(
      measureLookLaneOffsets(
        mapData([
          ['a', ...rht],
          ['b', ...rht],
          ['wide', [6.25, 10.75], [-6.25, -10.75]],
        ]),
      ).looks.has('hw'),
    ).toBe(false);
  });
});
