// Cleaner road rendering on top of the regular map GeoJSON:
//  - prefabs whose AI lanes all follow simple node-to-node curves (junctions,
//    roundabouts, most interchanges) are drawn with one smooth curve per
//    entry/exit node pair ("connectors") instead of the game's crude UI paths;
//  - the other prefabs (depots, service areas, odd junctions) are drawn with
//    their AI lanes, and the game's UI paths are only kept where no lane or
//    connector covers them (parking and access paths);
//  - toll plazas are drawn as one filled surface;
//  - holes left between road ends are closed;
//  - road types are fixed where the game reuses motorway templates on ordinary
//    roads;
//  - bridges are drawn above the roads they pass over (see road-levels.ts).
// Everything drawn for a prefab (connectors, lanes, kept UI paths) has
// `prefab: true`, so the map style can draw it over the roads, as the game does,
// and `yard: true` for the prefabs that aren't junctions (companies, service
// areas, parkings): the style draws their yards and inner roads over the
// roads that lead into them.
// Everything is computed in game coordinates (metres) and converted back.
import type { Position } from '@truckermudgeon/base/geom';
import { toSplinePoints } from '@truckermudgeon/base/geom';
import type { MappedDataForKeys } from '@truckermudgeon/io';
import { calculateLaneInfo, toMapPosition } from '@truckermudgeon/map/prefabs';
import {
  fromAtsCoordsToWgs84,
  fromEts2CoordsToWgs84,
  fromWgs84ToAtsCoords,
  fromWgs84ToEts2Coords,
} from '@truckermudgeon/map/projections';
import type { PrefabDescription } from '@truckermudgeon/map/types';
import type { GeoJSON } from 'geojson';
import polygonClipping from 'polygon-clipping';
import RBush from 'rbush';
import { logger } from '../logger';
import { liftBridges } from './road-levels';

type P = [number, number];
type RoadType = 'freeway' | 'divided' | 'local';
const RANK: Record<string, number> = { local: 0, divided: 1, freeway: 2 };

export const cleanRoadsMapDataKeys = [
  'nodes',
  'roads',
  'prefabs',
  'prefabDescriptions',
] as const;
type CleanRoadsData = MappedDataForKeys<
  ['nodes', 'roads', 'prefabs', 'prefabDescriptions']
> & { map: 'usa' | 'europe' };

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;

// prefab categories (second path element) that only hold node-to-node lanes
export const JUNCTION_DIRS = [
  'fork_temp',
  'cross_temp',
  'round_temp',
  'fork',
  'cross',
  'round',
];

// ---------- geometry helpers (game metres) ----------

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angle = (a: P, b: P) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const unit = (a: P, b: P): P => {
  const d = dist(a, b) || 1;
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
};
const lineLength = (l: P[]) =>
  l.reduce((s, p, i) => (i ? s + dist(l[i - 1], p) : 0), 0);

function projectOnSegment(p: P, a: P, b: P): { q: P; d: number } {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t =
    l2 === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2),
        );
  const q: P = [a[0] + t * dx, a[1] + t * dy];
  return { q, d: dist(p, q) };
}

function hermite(a: P, ra: number, b: P, rb: number): P[] {
  if (dist(a, b) < 0.01) return [a, b];
  return toSplinePoints(
    { position: a, rotation: ra },
    { position: b, rotation: rb },
  ) as P[];
}

function segmentize(l: P[], step: number): P[] {
  const out: P[] = [l[0]];
  for (let i = 1; i < l.length; i++) {
    const n = Math.max(1, Math.ceil(dist(l[i - 1], l[i]) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([
        l[i - 1][0] + (l[i][0] - l[i - 1][0]) * t,
        l[i - 1][1] + (l[i][1] - l[i - 1][1]) * t,
      ]);
    }
  }
  return out;
}

function simplify(l: P[], tol: number): P[] {
  if (l.length < 3) return l;
  const keep = new Uint8Array(l.length);
  keep[0] = keep[l.length - 1] = 1;
  const stack: [number, number][] = [[0, l.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1,
      bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = projectOnSegment(l[k], l[i], l[j]).d;
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return l.filter((_, i) => keep[i]);
}

/** Spatial index over the segments of many polylines. */
class LineIndex {
  private tree = new RBush<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    line: number;
    a: P;
    b: P;
  }>();
  constructor(readonly lines: P[][]) {
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.length === 1) l.push(l[0]);
      for (let k = 1; k < l.length; k++) {
        const a = l[k - 1],
          b = l[k];
        items.push({
          minX: Math.min(a[0], b[0]),
          minY: Math.min(a[1], b[1]),
          maxX: Math.max(a[0], b[0]),
          maxY: Math.max(a[1], b[1]),
          line: i,
          a,
          b,
        });
      }
    }
    this.tree.load(items);
  }
  private near(p: P, r: number) {
    return this.tree.search({
      minX: p[0] - r,
      minY: p[1] - r,
      maxX: p[0] + r,
      maxY: p[1] + r,
    });
  }
  /** Ids of the lines passing within `r` of `p`. */
  within(p: P, r: number): Set<number> {
    const s = new Set<number>();
    for (const it of this.near(p, r))
      if (!s.has(it.line) && projectOnSegment(p, it.a, it.b).d <= r)
        s.add(it.line);
    return s;
  }
  any(p: P, r: number, accept?: (line: number) => boolean): boolean {
    for (const it of this.near(p, r))
      if (
        (!accept || accept(it.line)) &&
        projectOnSegment(p, it.a, it.b).d <= r
      )
        return true;
    return false;
  }
  nearest(p: P, r: number): { line: number; q: P; d: number } | undefined {
    let best: { line: number; q: P; d: number } | undefined;
    for (const it of this.near(p, r)) {
      const { q, d } = projectOnSegment(p, it.a, it.b);
      if (d <= r && (!best || d < best.d)) best = { line: it.line, q, d };
    }
    return best;
  }
}

/**
 * Whether `p` lies within `r` of the polyline `l`. Same test as
 * `LineIndex.any`, without building a tree: cheaper for a handful of lines.
 */
function nearLine(l: P[], p: P, r: number): boolean {
  if (l.length === 1) return projectOnSegment(p, l[0], l[0]).d <= r;
  for (let k = 1; k < l.length; k++)
    if (projectOnSegment(p, l[k - 1], l[k]).d <= r) return true;
  return false;
}

/** Spatial index over points. */
class PointIndex {
  private tree = new RBush<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    i: number;
  }>();
  constructor(readonly pts: P[]) {
    this.tree.load(
      pts.map((p, i) => ({
        minX: p[0],
        minY: p[1],
        maxX: p[0],
        maxY: p[1],
        i,
      })),
    );
  }
  within(p: P, r: number): number[] {
    return this.tree
      .search({
        minX: p[0] - r,
        minY: p[1] - r,
        maxX: p[0] + r,
        maxY: p[1] + r,
      })
      .filter(it => dist(this.pts[it.i], p) <= r)
      .map(it => it.i);
  }
  nearest(p: P, r: number): number | undefined {
    let best: number | undefined,
      bd = r;
    for (const i of this.within(p, r)) {
      const d = dist(this.pts[i], p);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
}

// polygon helpers for toll plazas
type Poly = polygonClipping.MultiPolygon;
function capsule(a: P, b: P, r: number, round: boolean): Poly {
  const [ux, uy] = unit(a, b);
  const [nx, ny] = [-uy, ux];
  const ring: P[] = [];
  const N = 6;
  if (!round) {
    ring.push(
      [a[0] + nx * r, a[1] + ny * r],
      [b[0] + nx * r, b[1] + ny * r],
      [b[0] - nx * r, b[1] - ny * r],
      [a[0] - nx * r, a[1] - ny * r],
    );
  } else {
    const base = Math.atan2(ny, nx);
    for (let k = 0; k <= N; k++) {
      const t = base - (Math.PI * k) / N;
      ring.push([b[0] + Math.cos(t) * r, b[1] + Math.sin(t) * r]);
    }
    for (let k = 0; k <= N; k++) {
      const t = base + Math.PI - (Math.PI * k) / N;
      ring.push([a[0] + Math.cos(t) * r, a[1] + Math.sin(t) * r]);
    }
  }
  // polygon-clipping fails on nearly coincident vertices: snap to the centimetre
  const snapped = ring.map(
    ([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as P,
  );
  snapped.push(snapped[0]);
  return [[snapped]];
}
function bufferLines(lines: P[][], r: number, round: boolean): Poly {
  const parts: Poly[] = [];
  for (const l of lines) {
    const s = simplify(l, 0.5);
    for (let i = 1; i < s.length; i++)
      if (dist(s[i - 1], s[i]) > 0.01)
        parts.push(capsule(s[i - 1], s[i], r, round));
  }
  if (!parts.length) return [];
  return polygonClipping.union(parts[0], ...parts.slice(1));
}
/** Morphological closing: grow by r, then shrink by r. */
function closePlaza(lanes: P[][], laneR: number, r: number): Poly {
  const grown = bufferLines(lanes, laneR + r, true);
  const rings = grown.flatMap(poly => poly.map(ring => ring as P[]));
  const edge = bufferLines(rings, r, true);
  return edge.length ? polygonClipping.difference(grown, edge) : grown;
}

// ---------- main ----------

export function cleanRoads(
  geoJson: GeoJSON.FeatureCollection,
  data: CleanRoadsData,
): void {
  const { nodes, prefabs, prefabDescriptions, map } = data;
  const toGame = map === 'usa' ? fromWgs84ToAtsCoords : fromWgs84ToEts2Coords;
  const toWgs = map === 'usa' ? fromAtsCoordsToWgs84 : fromEts2CoordsToWgs84;
  const g = (c: GeoJSON.Position[]) => c.map(p => toGame(p as P) as P);
  const w = (c: P[]) => c.map(p => toWgs(p));
  const features = geoJson.features as Feature[];
  const isRoad = (f: Feature) =>
    f.properties?.type === 'road' &&
    f.properties.roadType !== 'train' &&
    f.geometry.type === 'LineString' &&
    f.geometry.coordinates.length > 1;
  // the game's in-prefab UI paths are the road features made from prefab map points
  const isPath = (f: Feature) => String(f.id ?? '').includes('road');

  // --- prefab lanes (AI nav curves) and connectors ---
  logger.log('clean roads: prefab lanes and connectors...');
  interface PrefabInfo {
    uid: string;
    path: string;
    toll: boolean;
    junction: boolean;
    lanes: P[][];
    connectors: { pts: P[]; sh: P; eh: P }[];
    /** how far its lanes reach from the carriageway centers its connectors use */
    spread: number;
    /** roads go through it (two nodes or more), not just into it */
    through: boolean;
  }
  const infos: PrefabInfo[] = [];
  for (const p of prefabs.values()) {
    const desc = prefabDescriptions.get(p.token);
    if (!desc) continue;
    // Hidden prefabs (unreleased states, off-map stubs) keep their own
    // hidden road strings: redrawing them as connectors/lanes would show them.
    if (p.hidden) continue;
    const path = (desc as { path?: string }).path ?? '';
    const tx = (pos: Position) => toMapPosition(pos, p, desc, nodes) as P;
    const lanes: P[][] = desc.navCurves.map(c =>
      toSplinePoints(
        { position: [c.start.x, c.start.y], rotation: c.start.rotation },
        { position: [c.end.x, c.end.y], rotation: c.end.rotation },
      ).map(tx),
    );
    const info: PrefabInfo = {
      uid: p.uid.toString(16),
      path,
      toll: path.includes('/tollgate/'),
      junction: JUNCTION_DIRS.includes(path.split('/')[1] ?? ''),
      lanes,
      connectors: [],
      spread: 0,
      through: p.nodeUids.length >= 2,
    };
    infos.push(info);
    if (p.nodeUids.length < 2) continue;
    let laneInfo;
    try {
      laneInfo = calculateLaneInfo(desc);
    } catch {
      continue;
    }
    const n = p.nodeUids.length;
    const world = p.nodeUids.map((_, k) =>
      nodes.get(p.nodeUids[(k - p.originNodeIndex + n) % n]),
    );
    const pairs = new Set<string>();
    for (const [i, ls] of laneInfo) {
      for (const lane of ls) {
        for (const br of lane.branches) {
          const j = br.targetNodeIndex;
          if (!world[i] || !world[j] || i === j || br.curvePoints.length < 2)
            continue;
          pairs.add(`${i}-${j}`);
        }
      }
    }
    const ends = desc.nodes.map(nd => carriagewayEnds(desc, nd, tx));
    info.spread = Math.max(0, ...ends.map(e => e.spread));
    for (const key of pairs) {
      const [i, j] = key.split('-').map(Number);
      const a = world[i]!,
        b = world[j]!;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const fix = (r: number) =>
        Math.cos(r) * dx + Math.sin(r) * dy >= 0 ? r : r + Math.PI;
      info.connectors.push({
        pts: hermite([a.x, a.y], fix(a.rotation), [b.x, b.y], fix(b.rotation)),
        sh: ends[i].into,
        eh: ends[j].outOf,
      });
    }
  }

  // --- regular roads, to snap connector ends onto the carriageway the lanes use ---
  const regular: { pts: P[]; props: Record<string, unknown> }[] = [];
  const pathEnds: P[] = [];
  const pathEndProps: Record<string, unknown>[] = [];
  const pathEndIds: Feature['id'][] = [];
  for (const f of features) {
    if (!isRoad(f)) continue;
    const pts = g((f.geometry as GeoJSON.LineString).coordinates);
    if (!isPath(f)) regular.push({ pts, props: f.properties });
    for (const e of [pts[0], pts[pts.length - 1]]) {
      pathEnds.push(e);
      pathEndProps.push(f.properties);
      pathEndIds.push(f.id);
    }
  }
  const regIdx = new LineIndex(regular.map(r => r.pts));
  const endIdx = new PointIndex(pathEnds);
  // `other`: the connector's other node. In a short prefab, the road at the
  // other node can be the nearest one: never snap closer to it than to `node`.
  const snap = (node: P, hint: P, other: P) => {
    if (dist(node, hint) < 30) {
      const k = regIdx.nearest(hint, 6);
      if (k && dist(k.q, node) < 25 && dist(k.q, node) < dist(k.q, other))
        return { p: k.q, props: regular[k.line].props };
      // no road here (two prefabs meet): end where the carriageway is, so
      // both prefabs' connectors meet there instead of pinching on the node.
      return { p: hint, props: undefined };
    }
    return { p: node, props: undefined };
  };

  interface Conn {
    uid: string;
    pts: P[];
    props: Record<string, unknown>;
  }
  const conns = new Map<string, Conn[]>();
  for (const info of infos) {
    const seen = new Set<string>();
    for (const c of info.connectors) {
      const m = c.pts;
      const r0 = angle(m[0], m[1]),
        r1 = angle(m[m.length - 2], m[m.length - 1]);
      const a = snap(m[0], c.sh, m[m.length - 1]),
        b = snap(m[m.length - 1], c.eh, m[0]);
      if (dist(a.p, b.p) < 1) continue;
      const key = [a.p, b.p]
        .map(q => `${q[0].toFixed(1)},${q[1].toFixed(1)}`)
        .sort()
        .join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      let src = a.props ?? b.props;
      if (!src) {
        const k = endIdx.nearest(a.p, 60) ?? endIdx.nearest(b.p, 60);
        src =
          k != null
            ? pathEndProps[k]
            : { roadType: 'local', leftLanes: 1, rightLanes: 1 };
      }
      const list = conns.get(info.uid) ?? [];
      list.push({ uid: info.uid, pts: hermite(a.p, r0, b.p, r1), props: src });
      conns.set(info.uid, list);
    }
  }

  // --- prefabs drawn by connectors: every lane close to one of its connectors ---
  const simple = new Set<string>();
  for (const info of infos) {
    if (info.toll || !info.lanes.length) continue;
    const cs = conns.get(info.uid);
    if (!cs) continue;
    // a few connectors per prefab: test them directly rather than build a tree
    // connectors follow the middle of each carriageway: its outer lanes are
    // that much further from them.
    const tol = (info.junction ? 25 : 9) + info.spread;
    if (
      info.lanes.every(l => l.every(p => cs.some(c => nearLine(c.pts, p, tol))))
    )
      simple.add(info.uid);
  }
  logger.log(
    `clean roads: ${simple.size} of ${infos.filter(i => i.lanes.length && !i.toll).length} prefabs drawn by connectors`,
  );

  // --- toll plazas ---
  const plazas: Poly[] = [];
  for (const info of infos) {
    if (!info.toll || !info.lanes.length) continue;
    try {
      plazas.push(closePlaza(info.lanes, 2.4, 8));
    } catch {
      try {
        plazas.push(bufferLines(info.lanes, 2.4, true));
      } catch {
        // geometry the clipper cannot handle: draw this toll with its lanes
        info.toll = false;
        logger.warn(`clean roads: no plaza for toll prefab ${info.uid}`);
      }
    }
  }

  // Junctions, and prefabs roads go through (a motorway through a big
  // service station), that connectors can't draw keep the game's UI paths,
  // whole and at every zoom, as roads of their own: their AI lanes only
  // show from zoom 10, and thin, so the prefab (and the roads through it)
  // would vanish when zoomed out.
  const pathJunctions = new Set(
    infos
      .filter(
        i =>
          (i.junction || i.through) &&
          !i.toll &&
          i.lanes.length &&
          !simple.has(i.uid),
      )
      .map(i => i.uid),
  );
  const families = new Map<string, number>();
  for (const i of infos) {
    if (!pathJunctions.has(i.uid)) continue;
    const family = i.path.split('/').slice(1, 3).join('/');
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  logger.log(
    `clean roads: ${pathJunctions.size} junctions and through prefabs drawn with the game's paths (${[
      ...families,
    ]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([f, n]) => `${f} ${n}`)
      .join(', ')})`,
  );

  // --- drop the game's UI paths where lanes, connectors or plazas cover them ---
  const kept: P[][] = [],
    simpleConns: P[][] = [],
    simpleLanes: P[][] = [];
  for (const info of infos) {
    if (pathJunctions.has(info.uid)) continue;
    if (simple.has(info.uid)) {
      simpleLanes.push(...info.lanes);
      simpleConns.push(...(conns.get(info.uid) ?? []).map(c => c.pts));
    } else kept.push(...info.lanes);
  }
  const keptIdx = new LineIndex(kept.map(l => l.slice()));
  const connIdx = new LineIndex(simpleConns.map(l => l.slice()));
  const simpleLaneIdx = new LineIndex(simpleLanes.map(l => l.slice()));
  const plazaTree = new RBush<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    rings: P[][];
  }>();
  plazaTree.load(
    plazas.flatMap(mp =>
      mp.map(poly => {
        const ring = poly[0] as P[];
        return {
          minX: Math.min(...ring.map(p => p[0])),
          minY: Math.min(...ring.map(p => p[1])),
          maxX: Math.max(...ring.map(p => p[0])),
          maxY: Math.max(...ring.map(p => p[1])),
          rings: poly as P[][],
        };
      }),
    ),
  );
  const inRing = (p: P, ring: P[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i],
        [xj, yj] = ring[j];
      if (
        yi > p[1] !== yj > p[1] &&
        p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
      )
        inside = !inside;
    }
    return inside;
  };
  const inPlaza = (p: P) =>
    plazaTree
      .search({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] })
      .some(
        it =>
          inRing(p, it.rings[0]) && !it.rings.slice(1).some(h => inRing(p, h)),
      );
  const joinToConnector = (p: P): P => connIdx.nearest(p, 10)?.q ?? p;

  const infoByUid = new Map(infos.map(i => [i.uid, i]));
  // the prefab a UI path belongs to: its id is `<prefab uid>road<n>`
  const isYardPath = (f: Feature) =>
    infoByUid.get(String(f.id).split('road')[0])?.junction === false;
  const out: Feature[] = [];
  let keptPieces = 0;
  for (const f of features) {
    if (f.properties?.type === 'prefab' && f.properties.color === 3) continue; // big prefab hulls
    if (!isRoad(f) || !isPath(f)) {
      out.push(f);
      continue;
    }
    // a path's id is `<prefab uid>road<n>`
    if (pathJunctions.has(String(f.id).split('road')[0])) {
      // a service station's paths stay over its yard (see `yard`); the ones
      // that don't go from one of its nodes to another run inside the
      // station: local, whatever road the game typed them as (the motorway
      // through it keeps its type).
      // the game's path and the road it continues at a prefab node aren't
      // always on the same line (the road is drawn where its lanes are):
      // start and end on it.
      // At a divided road, the path ends on the node, between the two
      // carriageways: take the one on the side the path comes from.
      const pts = g((f.geometry as GeoJSON.LineString).coordinates);
      const atNode = [f.properties?.startNodeUid, f.properties?.endNodeUid];
      [0, pts.length - 1].forEach((k, end) => {
        if (pts.length < 2) return;
        // well back along the path: its last points can already be on the
        // road's middle line, merging
        const from = pointBack(pts, end === 1, 60);
        let best: { q: P; d: number } | undefined;
        const take = (q: P) => {
          const d = dist(q, from);
          if (!best || d < best.d) best = { q, d };
        };
        if (atNode[end] != null) {
          for (const line of regIdx.within(pts[k], 12))
            take(nearestOnLine(regular[line].pts, pts[k]));
        } else {
          // a ramp merging into a divided road can end off the node, between
          // the carriageways: join the end of the carriageway on its side.
          for (const i of endIdx.within(pts[k], 30))
            if (!isPath({ id: pathEndIds[i] } as Feature)) take(pathEnds[i]);
        }
        if (best) pts[k] = best.q;
      });
      const inYard = isYardPath(f);
      const through =
        f.properties?.startNodeUid != null && f.properties.endNodeUid != null;
      out.push({
        ...f,
        geometry: { type: 'LineString', coordinates: w(pts) },
        properties: {
          ...f.properties,
          prefab: true,
          ...(inYard ? { yard: true } : {}),
          ...(inYard && !through ? { roadType: 'local' } : {}),
        },
      });
      keptPieces++;
      continue;
    }
    const m = segmentize(g((f.geometry as GeoJSON.LineString).coordinates), 4);
    // per segment: drawn by connectors, plazas or simple lanes (dropped),
    // covered by the AI lanes of another prefab, or kept
    const state: ('drop' | 'lanes' | 'keep')[] = [];
    for (let i = 0; i + 1 < m.length; i++) {
      const mid: P = [(m[i][0] + m[i + 1][0]) / 2, (m[i][1] + m[i + 1][1]) / 2];
      const pts = [mid, m[i], m[i + 1]];
      state.push(
        pts.every(p => connIdx.any(p, 7)) ||
          inPlaza(mid) ||
          connIdx.any(mid, 6) ||
          simpleLaneIdx.any(mid, 5)
          ? 'drop'
          : pts.every(p => keptIdx.any(p, 4))
            ? 'lanes'
            : 'keep',
      );
    }
    let run: P[] = [];
    let runState: (typeof state)[number] = 'drop';
    let piece = 0;
    const flush = () => {
      if (run.length >= 2 && lineLength(run) >= 15) {
        run[0] = joinToConnector(run[0]);
        run[run.length - 1] = joinToConnector(run[run.length - 1]);
        out.push({
          type: 'Feature',
          id: `${f.id}p${piece++}`,
          // drawn over the roads, like the rest of the prefab
          properties: {
            ...f.properties,
            prefab: true,
            ...(isYardPath(f) ? { yard: true } : {}),
          },
          geometry: { type: 'LineString', coordinates: w(simplify(run, 0.3)) },
          // AI lanes only show from zoom 10 (see below): until then, the
          // game's path keeps the junction drawn.
          ...(runState === 'lanes' ? { tippecanoe: { maxzoom: 9 } } : {}),
        } as Feature);
        if (runState === 'keep') keptPieces++;
      }
      run = [];
    };
    state.forEach((st, i) => {
      if (st !== runState) flush();
      runState = st;
      if (st === 'drop') return;
      if (!run.length) run = [m[i]];
      run.push(m[i + 1]);
    });
    flush();
  }

  const connFeatures: Feature[] = [];
  for (const uid of simple)
    for (const c of conns.get(uid) ?? []) {
      const s = c.props;
      connFeatures.push({
        type: 'Feature',
        properties: {
          type: 'road',
          roadType: s.roadType,
          leftLanes: s.leftLanes,
          rightLanes: s.rightLanes,
          dlcGuard: s.dlcGuard,
          hidden: false,
          secret: false,
          connector: true,
          prefab: true,
          ...(infoByUid.get(uid)?.junction === false ? { yard: true } : {}),
        },
        geometry: { type: 'LineString', coordinates: w(c.pts) },
      });
    }
  for (const f of connFeatures) out.push(f);
  logger.log(
    `clean roads: ${connFeatures.length} connectors, ${keptPieces} game path pieces kept`,
  );

  // --- close holes between road ends ---
  const gapCount = closeGaps(out, g, w);
  logger.log(`clean roads: ${gapCount} gaps closed`);

  // --- road types ---
  const lowered = lowerConnectorTypes(out, g);
  logger.log(
    `clean roads: ${lowered} connectors lowered to the type of the road they join`,
  );
  const laneOf = (info: PrefabInfo) =>
    !info.toll && !simple.has(info.uid) && !pathJunctions.has(info.uid);
  // demoteIsolatedMotorways only retypes roads: the index serves both passes
  const roads = roadLineIndex(out, g);
  let lanes = typeLanes(infos.filter(laneOf), out, roads);
  const demoted = demoteIsolatedMotorways(out, lanes, g);
  logger.log(`clean roads: ${demoted} single-lane motorway stretches retyped`);
  lanes = typeLanes(infos.filter(laneOf), out, roads);

  for (const l of lanes)
    out.push({
      type: 'Feature',
      properties: {
        type: 'road',
        roadType: l.roadType,
        lane: true,
        prefab: true,
        ...(l.yard ? { yard: true } : {}),
        hidden: false,
        secret: false,
        dlcGuard: 0,
      },
      geometry: { type: 'LineString', coordinates: w(l.pts) },
      // too fine to see below zoom 10
      tippecanoe: { minzoom: 10 },
    } as Feature);
  for (const mp of plazas)
    for (const poly of mp)
      out.push({
        type: 'Feature',
        properties: { type: 'plaza', roadType: 'freeway', dlcGuard: 0 },
        geometry: {
          type: 'Polygon',
          coordinates: poly.map(r => w(simplify(r as P[], 0.3))),
        },
      });
  const bridges = liftBridges(out, g, w, data);
  logger.log(`clean roads: ${bridges} crossings drawn as bridges`);
  geoJson.features = out as GeoJSON.Feature[];
}

/** The point `back` metres along a polyline from its start or (`fromEnd`) end. */
function pointBack(l: P[], fromEnd: boolean, back: number): P {
  const pts = fromEnd ? [...l].reverse() : l;
  let left = back;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (d >= left) {
      const t = left / d;
      return [
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      ];
    }
    left -= d;
  }
  return pts[pts.length - 1];
}

/** The point of a polyline closest to `p`. */
function nearestOnLine(l: P[], p: P): P {
  let best = l[0];
  let bd = Infinity;
  for (let i = 1; i < l.length; i++) {
    const { q, d } = projectOnSegment(p, l[i - 1], l[i]);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/** Space between two carriageways from which they are drawn apart. */
const MIN_MEDIAN = 3;

/**
 * Where a prefab node's carriageways are, from its lanes' ends: `into` for the
 * lanes entering the prefab, `outOf` for the ones leaving it. Without a median
 * (a road drawn as one line) both are the middle of all lanes. `spread` is
 * how far the lanes reach from those centers.
 */
function carriagewayEnds(
  desc: PrefabDescription,
  node: PrefabDescription['nodes'][number],
  tx: (pos: Position) => P,
): { into: P; outOf: P; spread: number } {
  const pos = (c: { x: number; y: number }) => tx([c.x, c.y]);
  const into = node.inputLanes.flatMap(ci => {
    const c = desc.navCurves[ci];
    return c ? [pos(c.start)] : [];
  });
  const outOf = node.outputLanes.flatMap(ci => {
    const c = desc.navCurves[ci];
    return c ? [pos(c.end)] : [];
  });
  const all = [...into, ...outOf];
  if (!all.length) {
    const at = tx([node.x, node.y]);
    return { into: at, outOf: at, spread: 0 };
  }
  const reach = (ps: P[], c: P) => Math.max(0, ...ps.map(q => dist(q, c)));
  const middle = mean(all);
  const oneLine = { into: middle, outOf: middle, spread: reach(all, middle) };
  if (!into.length || !outOf.length) return oneLine;
  // lanes a lane width apart are neighbors; a gap of a lane width plus the
  // median between the closest lanes of each side makes two carriageways.
  let gap = Infinity;
  for (const a of into) for (const b of outOf) gap = Math.min(gap, dist(a, b));
  if (gap < LANE_WIDTH + MIN_MEDIAN) return oneLine;
  const [ci, co] = [mean(into), mean(outOf)];
  return {
    into: ci,
    outOf: co,
    spread: Math.max(reach(into, ci), reach(outOf, co)),
  };
}

const LANE_WIDTH = 4.5;

function mean(ps: P[]): P {
  return [
    ps.reduce((s, q) => s + q[0], 0) / ps.length,
    ps.reduce((s, q) => s + q[1], 0) / ps.length,
  ];
}

type ToGame = (c: GeoJSON.Position[]) => P[];
type ToWgs = (c: P[]) => Position[];

/**
 * Joins each road end that nothing continues (generator chains that got dropped
 * between two prefabs, for example) to the nearest such end facing it.
 */
function closeGaps(features: Feature[], g: ToGame, w: ToWgs): number {
  const MAXD = 45,
    COS = Math.cos((35 * Math.PI) / 180),
    TOUCH = 1.5;
  const lines: P[][] = [],
    owner: number[] = [];
  const ends: { p: P; d: P; f: number }[] = [];
  features.forEach((f, k) => {
    if (f.properties?.type !== 'road' || f.geometry.type !== 'LineString')
      return;
    const m = g(f.geometry.coordinates);
    if (m.length < 2) return;
    lines.push(m);
    owner.push(k);
    if (f.properties.roadType === 'train') return;
    for (const [pt, q] of [
      [m[0], m[1]],
      [m[m.length - 1], m[m.length - 2]],
    ] as [P, P][])
      if (dist(pt, q) > 0) ends.push({ p: pt, d: unit(q, pt), f: k });
  });
  const idx = new LineIndex(lines);
  const seen = new Set<string>();
  const dangling: number[] = [];
  ends.forEach((e, i) => {
    const probe: P = [e.p[0] + e.d[0] * 3, e.p[1] + e.d[1] * 3];
    if (idx.any(probe, TOUCH, l => owner[l] !== e.f)) return;
    // a fork node is one dangling end, whatever the number of features ending there
    const key = `${Math.round(e.p[0] * 2)},${Math.round(e.p[1] * 2)},${Math.round((Math.atan2(e.d[1], e.d[0]) * 180) / Math.PI / 20)}`;
    if (seen.has(key)) return;
    seen.add(key);
    dangling.push(i);
  });
  const dIdx = new PointIndex(dangling.map(i => ends[i].p));
  const cand: [number, number, number][] = [];
  dangling.forEach((a, ai) => {
    const ea = ends[a];
    for (const bk of dIdx.within(ea.p, MAXD)) {
      if (bk <= ai) continue;
      const eb = ends[dangling[bk]];
      if (eb.f === ea.f) continue;
      const L = dist(ea.p, eb.p);
      if (L < 0.3) continue;
      const u = unit(ea.p, eb.p);
      if (ea.d[0] * u[0] + ea.d[1] * u[1] < COS) continue;
      if (-(eb.d[0] * u[0] + eb.d[1] * u[1]) < COS) continue;
      cand.push([L, a, dangling[bk]]);
    }
  });
  cand.sort((x, y) => x[0] - y[0]);
  const used = new Set<number>();
  let n = 0;
  for (const [, a, b] of cand) {
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    const ea = ends[a],
      eb = ends[b];
    const src = features[ea.f].properties;
    features.push({
      type: 'Feature',
      properties: {
        type: 'road',
        roadType: src.roadType,
        leftLanes: src.leftLanes,
        rightLanes: src.rightLanes,
        dlcGuard: src.dlcGuard,
        hidden: src.hidden,
        secret: src.secret,
        gap: true,
      },
      geometry: {
        type: 'LineString',
        coordinates: w(
          hermite(
            ea.p,
            Math.atan2(ea.d[1], ea.d[0]),
            eb.p,
            Math.atan2(-eb.d[1], -eb.d[0]),
          ),
        ),
      },
    });
    n++;
  }
  return n;
}

/**
 * A connector between two road types (motorway exit onto a local road) takes
 * the lower one, so the motorway colour stops where the motorway does. The type
 * at an end is the highest type among the other roads meeting there.
 */
function lowerConnectorTypes(features: Feature[], g: ToGame): number {
  const lines: P[][] = [],
    types: string[] = [],
    feat: number[] = [];
  features.forEach((f, k) => {
    const t = f.properties?.roadType as string;
    if (
      f.properties?.type !== 'road' ||
      !(t in RANK) ||
      f.geometry.type !== 'LineString'
    )
      return;
    const m = g(f.geometry.coordinates);
    if (m.length < 2) return;
    lines.push(m);
    types.push(t);
    feat.push(k);
  });
  const idx = new LineIndex(lines);
  let n = 0;
  const orig = types.slice();
  lines.forEach((m, i) => {
    const p = features[feat[i]].properties;
    if (!p.connector) return;
    const at: string[] = [];
    for (const e of [m[0], m[m.length - 1]]) {
      const o = [...idx.within(e, 1.5)].filter(j => j !== i).map(j => orig[j]);
      if (!o.length) return;
      at.push(o.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)));
    }
    const low = RANK[at[0]] <= RANK[at[1]] ? at[0] : at[1];
    if (RANK[low] < RANK[p.roadType as string]) {
      p.roadType = low;
      n++;
    }
  });
  return n;
}

interface TypedLane {
  pts: P[];
  roadType: RoadType;
  /** a lane of a prefab that isn't a junction (company, service area...) */
  yard?: boolean;
}

/** Index of the road features `typeLanes` looks at, with their feature index. */
interface RoadLineIndex {
  idx: LineIndex;
  feat: number[];
}

function roadLineIndex(features: Feature[], g: ToGame): RoadLineIndex {
  const lines: P[][] = [],
    feat: number[] = [];
  features.forEach((f, k) => {
    const t = f.properties?.roadType as string;
    if (
      f.properties?.type !== 'road' ||
      f.properties.lane ||
      String(f.id ?? '').includes('road') ||
      !(t in RANK) ||
      f.geometry.type !== 'LineString'
    )
      return;
    const m = g(f.geometry.coordinates);
    if (m.length < 2) return;
    lines.push(m);
    feat.push(k);
  });
  return { idx: new LineIndex(lines), feat };
}

/**
 * Road type of the lanes drawn for prefabs not drawn by connectors: a junction
 * whose roads are all motorway (or all divided) keeps that type; depots, service
 * areas and other non-junction prefabs are local; in a mixed junction a lane keeps
 * motorway/divided only when both its ends meet that type.
 */
function typeLanes(
  infos: { junction: boolean; lanes: P[][] }[],
  features: Feature[],
  roads: RoadLineIndex,
): TypedLane[] {
  // types are read now: they may have changed since the index was built
  const types = roads.feat.map(k => features[k].properties.roadType as string);
  const at = (p: P) => new Set([...roads.idx.within(p, 6)].map(i => types[i]));
  const out: TypedLane[] = [];
  for (const info of infos) {
    const ends = info.lanes.map(l => [at(l[0]), at(l[l.length - 1])] as const);
    const touch = new Set(ends.flatMap(([a, b]) => [...a, ...b]));
    let whole: RoadType | undefined;
    if (info.junction && touch.size) {
      if (touch.size === 1 && touch.has('freeway')) whole = 'freeway';
      else if ([...touch].every(t => t === 'freeway' || t === 'divided'))
        whole = 'divided';
    }
    info.lanes.forEach((pts, k) => {
      let rt: RoadType = whole ?? 'local';
      if (!whole && info.junction) {
        const [a, b] = ends[k];
        for (const t of ['freeway', 'divided'] as const)
          if (a.has(t) && b.has(t)) {
            rt = t;
            break;
          }
      }
      out.push({ pts, roadType: rt, yard: !info.junction });
    });
  }
  return out;
}

/**
 * A short single-lane stretch typed motorway that touches no other motorway (a
 * one-way motorway template reused on an ordinary road) takes the type of the
 * roads around it. Real motorway stretches have two lanes or more.
 */
function demoteIsolatedMotorways(
  features: Feature[],
  lanes: TypedLane[],
  g: ToGame,
): number {
  const MAXLEN = 1500;
  const lines: P[][] = [],
    types: string[] = [],
    feat: (number | undefined)[] = [];
  features.forEach((f, k) => {
    if (
      f.properties?.type !== 'road' ||
      f.properties.roadType === 'train' ||
      f.geometry.type !== 'LineString'
    )
      return;
    const m = g(f.geometry.coordinates);
    if (m.length < 2) return;
    lines.push(m);
    types.push(f.properties.roadType as string);
    feat.push(k);
  });
  for (const l of lanes) {
    lines.push(l.pts);
    types.push(l.roadType);
    feat.push(undefined);
  }
  const idx = new LineIndex(lines.map(l => l.slice()));
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)!)!);
      a = parent.get(a)!;
    }
    return a;
  };
  const fw = types.flatMap((t, i) => (t === 'freeway' ? [i] : []));
  fw.forEach(i => parent.set(i, i));
  const around = new Map<number, Map<string, number>>();
  for (const i of fw) {
    const m = lines[i];
    for (const e of [m[0], m[m.length - 1]])
      for (const j of idx.within(e, 1.5)) {
        if (j === i) continue;
        if (types[j] === 'freeway') parent.set(find(i), find(j));
        else {
          const c = around.get(i) ?? new Map<string, number>();
          c.set(types[j], (c.get(types[j]) ?? 0) + 1);
          around.set(i, c);
        }
      }
  }
  const comps = new Map<number, number[]>();
  for (const i of fw) {
    const r = find(i);
    comps.set(r, [...(comps.get(r) ?? []), i]);
  }
  let n = 0;
  for (const mem of comps.values()) {
    if (mem.reduce((s, i) => s + lineLength(lines[i]), 0) >= MAXLEN) continue;
    const props = (i: number) =>
      feat[i] == null ? undefined : features[feat[i]].properties;
    if (
      mem.some(i => {
        const p = props(i);
        return (
          !p ||
          Math.max(Number(p.leftLanes ?? 0), Number(p.rightLanes ?? 0)) > 1
        );
      })
    )
      continue;
    const cnt = new Map<string, number>();
    for (const i of mem)
      for (const [t, c] of around.get(i) ?? [])
        cnt.set(t, (cnt.get(t) ?? 0) + c);
    if (!cnt.size) continue;
    const to =
      (cnt.get('divided') ?? 0) > (cnt.get('local') ?? 0) ? 'divided' : 'local';
    for (const i of mem) props(i)!.roadType = to;
    n++;
  }
  return n;
}
