import type { Position } from '@truckermudgeon/base/geom';
import { toMapPosition } from '@truckermudgeon/map/prefabs';
import type {
  Node,
  Prefab,
  PrefabDescription,
  Road,
  RoadLook,
} from '@truckermudgeon/map/types';

/**
 * Where a road look's lanes really are, relative to the line of nodes its
 * roads are placed on. Offsets are signed along the turf `lineOffset` normal
 * of the road's direction (`(dy, -dx)`), in meters, for right-hand traffic:
 * mirror them on roads that drive on the left (see `leftHandRoads`).
 */
export interface LookLaneOffsets {
  /** Mean offset of the lanes that drive in the road's direction (`lanesRight`). */
  forward: number;
  /** Mean offset of the lanes that drive against it (`lanesLeft`). */
  backward: number;
  /** Space between the two carriageways' inner lane edges. */
  median: number;
  /** Distance between the centers of two neighboring lanes. */
  laneWidth: number;
  samples: number;
  agreement: number;
}

/** Minimum median for a look to be drawn as two carriageways. */
export const MIN_DIVIDED_MEDIAN = 3;

const MIN_SAMPLES = 3;
const MIN_AGREEMENT = 0.9;
// two samples agree when their carriageway centers are this close
const AGREEMENT_TOLERANCE = 0.5;
// lane ends further than this along the road aren't on the node
const MAX_ALONG = 2;
const DEFAULT_LANE_WIDTH = 4.5;

export interface MeasuredLaneOffsets {
  looks: Map<string, LookLaneOffsets>;
  /** Roads whose traffic drives on the left (UK). */
  leftHandRoads: Set<bigint>;
}

interface Sample {
  forward: number[];
  backward: number[];
}

const isVehicleLane = (lane: string) =>
  !lane.startsWith('traffic_lane.no_vehicles') &&
  !lane.startsWith('traffic_lane.rail.');

/**
 * Measures, for each road look, where its lanes are relative to its roads'
 * node line, from the AI nav curves of the prefabs those roads connect to.
 * A look is only kept with at least 3 samples, 90% of which agree: one
 * odd prefab shouldn't move every road of that look.
 */
export function measureLookLaneOffsets(data: {
  roads: ReadonlyMap<bigint, Road>;
  roadLooks: ReadonlyMap<string, RoadLook>;
  prefabs: ReadonlyMap<bigint, Prefab>;
  prefabDescriptions: ReadonlyMap<string, PrefabDescription>;
  nodes: ReadonlyMap<bigint, Node>;
}): MeasuredLaneOffsets {
  const { roads, roadLooks, prefabs, prefabDescriptions, nodes } = data;

  // node uid -> roads (with the end that touches it)
  const roadEnds = new Map<bigint, { road: Road; atStart: boolean }[]>();
  for (const road of roads.values()) {
    if (road.hidden) continue;
    for (const [uid, atStart] of [
      [road.startNodeUid, true],
      [road.endNodeUid, false],
    ] as const) {
      let ends = roadEnds.get(uid);
      if (!ends) roadEnds.set(uid, (ends = []));
      ends.push({ road, atStart });
    }
  }

  const samples = new Map<string, Sample[]>();
  // road uid -> votes for left-hand traffic (> 0) or right-hand (< 0)
  const sideVotes = new Map<bigint, number>();
  for (const prefab of prefabs.values()) {
    const desc = prefabDescriptions.get(prefab.token);
    if (!desc || prefab.hidden || desc.navCurves.length === 0) continue;
    const n = prefab.nodeUids.length;
    if (n !== desc.nodes.length) continue;
    const tx = (p: Position) => toMapPosition(p, prefab, desc, nodes);

    for (let k = 0; k < n; k++) {
      const uid = prefab.nodeUids[(k - prefab.originNodeIndex + n) % n];
      const node = nodes.get(uid);
      const ends = roadEnds.get(uid);
      if (!node || !ends) continue;

      // lane ends at this node, with their direction of travel (map space)
      const laneEnds: { pos: Position; dir: Position }[] = [];
      const addLaneEnd = (at: { x: number; y: number; rotation: number }) => {
        const pos = tx([at.x, at.y]);
        const ahead = tx([
          at.x + Math.cos(at.rotation),
          at.y + Math.sin(at.rotation),
        ]);
        laneEnds.push({
          pos,
          // nav curve rotations follow the direction of travel already.
          dir: [ahead[0] - pos[0], ahead[1] - pos[1]],
        });
      };
      for (const ci of desc.nodes[k].inputLanes) {
        const c = desc.navCurves[ci];
        if (c) addLaneEnd(c.start);
      }
      for (const ci of desc.nodes[k].outputLanes) {
        const c = desc.navCurves[ci];
        if (c) addLaneEnd(c.end);
      }
      if (laneEnds.length === 0) continue;

      for (const { road, atStart } of ends) {
        // lane variants change the lane counts; the look's counts wouldn't match.
        if (road.leftLanesVariant || road.rightLanesVariant) continue;
        const look = roadLooks.get(road.roadLookToken);
        if (!look) continue;
        const other = nodes.get(atStart ? road.endNodeUid : road.startNodeUid);
        if (!other) continue;
        // the road's direction (start -> end) at this node
        let fx = Math.cos(node.rotation);
        let fy = Math.sin(node.rotation);
        const cx = atStart ? other.x - node.x : node.x - other.x;
        const cy = atStart ? other.y - node.y : node.y - other.y;
        if (fx * cx + fy * cy < 0) {
          fx = -fx;
          fy = -fy;
        }
        const forward: number[] = [];
        const backward: number[] = [];
        let off = false;
        for (const { pos, dir } of laneEnds) {
          const dx = pos[0] - node.x;
          const dy = pos[1] - node.y;
          if (Math.abs(dx * fx + dy * fy) > MAX_ALONG) {
            off = true;
            break;
          }
          const lateral = dx * fy - dy * fx;
          const side = dir[0] * fx + dir[1] * fy >= 0 ? forward : backward;
          // several curves can start from the same lane
          if (!side.some(v => Math.abs(v - lateral) < 0.3)) side.push(lateral);
        }
        if (off) continue;
        if (
          forward.length !== look.lanesRight.filter(isVehicleLane).length ||
          backward.length !== look.lanesLeft.filter(isVehicleLane).length ||
          forward.length === 0 ||
          backward.length === 0
        ) {
          continue;
        }
        // forward lanes on the normal's side: traffic drives on the left.
        // mirror the sample so every look is measured for right-hand traffic.
        const leftHand = mean(forward) > mean(backward);
        sideVotes.set(
          road.uid,
          (sideVotes.get(road.uid) ?? 0) + (leftHand ? 1 : -1),
        );
        const mirror = (vs: number[]) => (leftHand ? vs.map(v => -v) : vs);
        let list = samples.get(road.roadLookToken);
        if (!list) samples.set(road.roadLookToken, (list = []));
        list.push({ forward: mirror(forward), backward: mirror(backward) });
      }
    }
  }

  const looks = new Map<string, LookLaneOffsets>();
  for (const [token, list] of samples) {
    if (list.length < MIN_SAMPLES) continue;
    const fwd = list.map(s => mean(s.forward));
    const bwd = list.map(s => mean(s.backward));
    const forward = median(fwd);
    const backward = median(bwd);
    const agreeing = list.filter(
      (_, i) =>
        Math.abs(fwd[i] - forward) <= AGREEMENT_TOLERANCE &&
        Math.abs(bwd[i] - backward) <= AGREEMENT_TOLERANCE,
    );
    const agreement = agreeing.length / list.length;
    if (agreement < MIN_AGREEMENT) continue;

    const spacings = agreeing.flatMap(s => [
      ...neighborSpacings(s.forward),
      ...neighborSpacings(s.backward),
    ]);
    const laneWidth = spacings.length ? median(spacings) : DEFAULT_LANE_WIDTH;
    const gaps = agreeing.map(s => innerGap(s.forward, s.backward));
    looks.set(token, {
      forward,
      backward,
      median: Math.max(0, median(gaps) - laneWidth),
      laneWidth,
      samples: list.length,
      agreement,
    });
  }
  return { looks, leftHandRoads: spreadLeftHand(sideVotes, roadEnds) };
}

/**
 * Roads that drive on the left: the ones whose prefab ends say so, plus the
 * roads connected to them through road-to-road nodes, each taking the side of
 * the nearest road that was measured.
 */
function spreadLeftHand(
  sideVotes: ReadonlyMap<bigint, number>,
  roadEnds: ReadonlyMap<bigint, { road: Road }[]>,
): Set<bigint> {
  const known = new Map<bigint, boolean>(
    [...sideVotes].filter(([, v]) => v !== 0).map(([uid, v]) => [uid, v > 0]),
  );
  const byUid = new Map<bigint, Road>();
  for (const ends of roadEnds.values()) {
    for (const { road } of ends) byUid.set(road.uid, road);
  }
  // breadth-first from every road whose side is known, nearest seed wins.
  let frontier = [...known.keys()];
  while (frontier.length) {
    const next: bigint[] = [];
    for (const uid of frontier) {
      const road = byUid.get(uid);
      if (!road) continue;
      const side = known.get(uid)!;
      for (const nodeUid of [road.startNodeUid, road.endNodeUid]) {
        for (const { road: other } of roadEnds.get(nodeUid) ?? []) {
          if (known.has(other.uid)) continue;
          known.set(other.uid, side);
          next.push(other.uid);
        }
      }
    }
    frontier = next;
  }
  return new Set([...known].filter(([, left]) => left).map(([uid]) => uid));
}

/** Center-to-center distance between the two carriageways' innermost lanes. */
function innerGap(forward: number[], backward: number[]): number {
  let best = Infinity;
  for (const f of forward) {
    for (const b of backward) best = Math.min(best, Math.abs(f - b));
  }
  return best;
}

function neighborSpacings(offsets: number[]): number[] {
  const sorted = [...offsets].sort((a, b) => a - b);
  return sorted.slice(1).map((v, i) => v - sorted[i]);
}

function mean(vs: number[]): number {
  return vs.reduce((s, v) => s + v, 0) / vs.length;
}

function median(vs: number[]): number {
  const sorted = [...vs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
