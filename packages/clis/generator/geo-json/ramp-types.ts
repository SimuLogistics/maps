import { getItemRoadType } from '@truckermudgeon/map/roads';
import type {
  Node,
  Prefab,
  PrefabDescription,
  Road,
  RoadLook,
} from '@truckermudgeon/map/types';
import { hasLoop } from './clean-roads';

/** Longest run of one-way roads still taken for a motorway ramp. */
const MAX_RAMP_LENGTH = 3000;

const isVehicleLane = (lane: string) =>
  !lane.startsWith('traffic_lane.no_vehicles') &&
  !lane.startsWith('traffic_lane.rail.');

/**
 * Roads to draw as motorway: motorway ramps the game builds with another
 * road look (a local bridge in the middle of a cloverleaf, a whole ramp with
 * an expressway look). Those are runs of one-way roads that only lead to
 * motorways: at each end, directly or through a prefab, a motorway and no
 * other road. A run reaching a two-way road (the ramp of a diamond
 * interchange, a carriageway of a divided road) or a roundabout (its ring is
 * one-way roads too, between the ramps it joins) keeps its look's type.
 */
export function motorwayRamps(data: {
  roads: ReadonlyMap<bigint, Road>;
  roadLooks: ReadonlyMap<string, RoadLook>;
  prefabs: ReadonlyMap<bigint, Prefab>;
  prefabDescriptions: ReadonlyMap<string, PrefabDescription>;
  nodes: ReadonlyMap<bigint, Node>;
}): Set<bigint> {
  const { roads, roadLooks, prefabs, prefabDescriptions, nodes } = data;
  const roundabouts = new Set<string>();
  for (const [token, d] of prefabDescriptions) {
    const path = (d as { path?: string }).path ?? '';
    if (/round/i.test(path) || hasLoop(d.navCurves)) roundabouts.add(token);
  }
  type Kind = 'freeway' | 'oneWay' | 'other';
  const kinds = new Map<bigint, Kind>();
  for (const r of roads.values()) {
    if (r.hidden) continue;
    const look = roadLooks.get(r.roadLookToken);
    if (!look) continue;
    const left = look.lanesLeft.filter(isVehicleLane).length;
    const right = look.lanesRight.filter(isVehicleLane).length;
    kinds.set(
      r.uid,
      getItemRoadType(r, look) === 'freeway'
        ? 'freeway'
        : left === 0 || right === 0
          ? 'oneWay'
          : 'other',
    );
  }

  const roadsAt = new Map<bigint, bigint[]>();
  const prefabsAt = new Map<bigint, Prefab[]>();
  const add = <T>(m: Map<bigint, T[]>, k: bigint, v: T) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  for (const r of roads.values()) {
    if (!kinds.has(r.uid)) continue;
    add(roadsAt, r.startNodeUid, r.uid);
    add(roadsAt, r.endNodeUid, r.uid);
  }
  for (const p of prefabs.values()) {
    if (p.hidden) continue;
    for (const n of p.nodeUids) add(prefabsAt, n, p);
  }

  const ramps = new Set<bigint>();
  const seen = new Set<bigint>();
  for (const [uid, kind] of kinds) {
    if (kind !== 'oneWay' || seen.has(uid)) continue;
    // the run: one-way roads joined end to end
    const run: bigint[] = [];
    const todo = [uid];
    seen.add(uid);
    let motorway = false,
      twoWay = false,
      length = 0;
    const meet = (k: Kind | undefined) => {
      if (k === 'freeway') motorway = true;
      else if (k === 'other') twoWay = true;
    };
    while (todo.length) {
      const id = todo.pop()!;
      run.push(id);
      const r = roads.get(id)!;
      const a = nodes.get(r.startNodeUid),
        b = nodes.get(r.endNodeUid);
      if (a && b) length += Math.hypot(b.x - a.x, b.y - a.y);
      for (const n of [r.startNodeUid, r.endNodeUid]) {
        for (const o of roadsAt.get(n) ?? []) {
          if (o === id) continue;
          const k = kinds.get(o);
          if (k === 'oneWay') {
            if (!seen.has(o)) {
              seen.add(o);
              todo.push(o);
            }
          } else meet(k);
        }
        // through a prefab: the roads at its other nodes. Another one-way
        // road there that isn't a motorway is a road of its own the run
        // joins (the next piece of a roundabout's ring), not a motorway.
        for (const p of prefabsAt.get(n) ?? []) {
          if (roundabouts.has(p.token)) twoWay = true;
          for (const pn of p.nodeUids) {
            if (pn === n) continue;
            for (const o of roadsAt.get(pn) ?? []) {
              const k = kinds.get(o);
              meet(k === 'oneWay' ? 'other' : k);
            }
          }
        }
      }
    }
    if (motorway && !twoWay && length <= MAX_RAMP_LENGTH)
      for (const id of run) ramps.add(id);
  }
  return ramps;
}
