// Bridges: where a road passes over another one, the stretch that covers it is
// drawn one level up (`level` property), so the map style can draw it, casing
// included, above the road underneath. The rest of the road stays on the
// ground: a bridge never covers the junction that follows it.
// Everything is computed in game coordinates (metres).
import type { Position } from '@truckermudgeon/base/geom';
import { toSplinePoints } from '@truckermudgeon/base/geom';
import { toMapPosition } from '@truckermudgeon/map/prefabs';
import type {
  Node,
  Prefab,
  PrefabDescription,
  Road,
} from '@truckermudgeon/map/types';
import type { GeoJSON } from 'geojson';
import RBush from 'rbush';

type P = [number, number];
type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;

/** Height difference from which a road passes over another one. */
const MIN_CLEARANCE = 4.5;
/** Highest level drawn. */
const MAX_LEVEL = 3;
// a road's height is read on the game's roads and lanes this close to it,
// running the same way (its carriageways can be offset from the road's nodes).
const HEIGHT_RADIUS = 15;
const HEIGHT_MIN_COS = 0.85;
// half the width of the road underneath, plus a margin, as drawn on the map
const COVER = 15;
const MAX_COVER = 60;
// lines closer than this cross, even if they only touch (a road starting on
// the edge of the one above it): the lines are drawn wider than that.
const NEAR = 6;
// lines closer to parallel than this don't cross (two levels of one road)
const MIN_SIN = 0.25;

interface HeightSegment {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  a: P;
  b: P;
  za: number;
  zb: number;
}

export interface HeightData {
  roads: ReadonlyMap<bigint, Road>;
  nodes: ReadonlyMap<bigint, Node>;
  prefabs: ReadonlyMap<bigint, Prefab>;
  prefabDescriptions: ReadonlyMap<string, PrefabDescription>;
}

/** Heights of the game's roads and prefab lanes, looked up by position. */
class Heights {
  private tree = new RBush<HeightSegment>();

  constructor({ roads, nodes, prefabs, prefabDescriptions }: HeightData) {
    const items: HeightSegment[] = [];
    const add = (pts: P[], z0: number, z1: number) => {
      const total = length(pts);
      let s = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1],
          b = pts[i];
        const d = dist(a, b);
        const za = total ? z0 + ((z1 - z0) * s) / total : z0;
        s += d;
        const zb = total ? z0 + ((z1 - z0) * s) / total : z1;
        items.push({
          minX: Math.min(a[0], b[0]),
          minY: Math.min(a[1], b[1]),
          maxX: Math.max(a[0], b[0]),
          maxY: Math.max(a[1], b[1]),
          a,
          b,
          za,
          zb,
        });
      }
    };
    for (const r of roads.values()) {
      const s = nodes.get(r.startNodeUid),
        e = nodes.get(r.endNodeUid);
      if (r.hidden || !s || !e) continue;
      add(
        toSplinePoints(
          { position: [s.x, s.y], rotation: s.rotation },
          { position: [e.x, e.y], rotation: e.rotation },
        ) as P[],
        s.z,
        e.z,
      );
    }
    for (const p of prefabs.values()) {
      const desc = prefabDescriptions.get(p.token);
      const origin = nodes.get(p.nodeUids[0]);
      if (p.hidden || !desc || !origin) continue;
      // prefabs are placed by their origin node; their tilt is left out.
      const dz = origin.z - desc.nodes[p.originNodeIndex].z;
      const tx = (pos: Position) => toMapPosition(pos, p, desc, nodes) as P;
      for (const c of desc.navCurves) {
        add(
          toSplinePoints(
            { position: [c.start.x, c.start.y], rotation: c.start.rotation },
            { position: [c.end.x, c.end.y], rotation: c.end.rotation },
          ).map(tx),
          c.start.z + dz,
          c.end.z + dz,
        );
      }
    }
    this.tree.load(items);
  }

  /** Height at `p` of a road or lane running along `dir`, if there's one. */
  at(p: P, dir: P): number | undefined {
    let best: { d: number; z: number } | undefined;
    for (const it of this.tree.search({
      minX: p[0] - HEIGHT_RADIUS,
      minY: p[1] - HEIGHT_RADIUS,
      maxX: p[0] + HEIGHT_RADIUS,
      maxY: p[1] + HEIGHT_RADIUS,
    })) {
      const u = unit(it.a, it.b);
      if (Math.abs(u[0] * dir[0] + u[1] * dir[1]) < HEIGHT_MIN_COS) continue;
      const { t, d } = project(p, it.a, it.b);
      if (d > HEIGHT_RADIUS || (best && d >= best.d)) continue;
      best = { d, z: it.za + (it.zb - it.za) * t };
    }
    return best?.z;
  }
}

interface Line {
  feature: Feature;
  pts: P[];
  /** height at each point */
  z: number[];
  /** distance along the line at each point */
  s: number[];
  /** stretches drawn above the ground: [from, to, level] in metres along the line */
  lifts: [number, number, number][];
}

interface LineSegment {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  line: number;
  i: number;
}

/**
 * Splits the road features passing over others, giving the covering stretch a
 * `level` (1 above the ground, 2 above a level 1 bridge, ...). Returns the
 * number of crossings drawn as bridges.
 */
export function liftBridges(
  features: Feature[],
  g: (c: GeoJSON.Position[]) => P[],
  w: (c: P[]) => Position[],
  data: HeightData,
): number {
  const heights = new Heights(data);
  const lines: Line[] = [];
  const kept: Feature[] = [];
  for (const f of features) {
    const p = f.properties;
    if (
      p?.type !== 'road' ||
      p.lane ||
      p.roadType === 'train' ||
      p.hidden ||
      f.geometry.type !== 'LineString' ||
      f.geometry.coordinates.length < 2
    ) {
      kept.push(f);
      continue;
    }
    const pts = g(f.geometry.coordinates);
    const z = heightsAlong(pts, heights);
    if (!z) {
      kept.push(f);
      continue;
    }
    const s = [0];
    for (let i = 1; i < pts.length; i++)
      s.push(s[i - 1] + dist(pts[i - 1], pts[i]));
    lines.push({ feature: f, pts, z, s, lifts: [] });
  }

  const tree = new RBush<LineSegment>();
  const segs: LineSegment[] = [];
  lines.forEach((l, line) => {
    for (let i = 1; i < l.pts.length; i++) {
      const a = l.pts[i - 1],
        b = l.pts[i];
      segs.push({
        minX: Math.min(a[0], b[0]),
        minY: Math.min(a[1], b[1]),
        maxX: Math.max(a[0], b[0]),
        maxY: Math.max(a[1], b[1]),
        line,
        i,
      });
    }
  });
  tree.load(segs);

  // crossings where one road is high enough above the other
  const crossings: {
    upper: number;
    lower: number;
    at: number;
    atLower: number;
    z: number;
    cover: number;
  }[] = [];
  for (const sa of segs) {
    for (const sb of tree.search({
      minX: sa.minX - NEAR,
      minY: sa.minY - NEAR,
      maxX: sa.maxX + NEAR,
      maxY: sa.maxY + NEAR,
    })) {
      if (sb.line <= sa.line) continue;
      const A = lines[sa.line],
        B = lines[sb.line];
      const hit = closest(
        A.pts[sa.i - 1],
        A.pts[sa.i],
        B.pts[sb.i - 1],
        B.pts[sb.i],
      );
      if (!hit || hit.d > NEAR || hit.sin < MIN_SIN) continue;
      const za = A.z[sa.i - 1] + (A.z[sa.i] - A.z[sa.i - 1]) * hit.t;
      const zb = B.z[sb.i - 1] + (B.z[sb.i] - B.z[sb.i - 1]) * hit.u;
      if (Math.abs(za - zb) <= MIN_CLEARANCE) continue;
      const atA = A.s[sa.i - 1] + (A.s[sa.i] - A.s[sa.i - 1]) * hit.t;
      const atB = B.s[sb.i - 1] + (B.s[sb.i] - B.s[sb.i - 1]) * hit.u;
      // a shallow crossing covers more of the road above
      const cover = Math.min(MAX_COVER, COVER / hit.sin);
      crossings.push(
        za > zb
          ? {
              upper: sa.line,
              lower: sb.line,
              at: atA,
              atLower: atB,
              z: za,
              cover,
            }
          : {
              upper: sb.line,
              lower: sa.line,
              at: atB,
              atLower: atA,
              z: zb,
              cover,
            },
      );
    }
  }

  // lowest bridges first, so the ones above them know their level
  crossings.sort((a, b) => a.z - b.z);
  const levelAt = (l: Line, s: number) =>
    l.lifts.reduce(
      (lv, [from, to, level]) =>
        s >= from && s <= to ? Math.max(lv, level) : lv,
      0,
    );
  for (const c of crossings) {
    const up = lines[c.upper];
    const level = Math.min(MAX_LEVEL, levelAt(lines[c.lower], c.atLower) + 1);
    up.lifts.push([c.at - c.cover, c.at + c.cover, level]);
  }

  let bridges = 0;
  const out = kept;
  for (const l of lines) {
    if (!l.lifts.length) {
      out.push(l.feature);
      continue;
    }
    bridges += l.lifts.length;
    for (const piece of splitByLevel(l)) {
      out.push({
        ...l.feature,
        properties: piece.level
          ? { ...l.feature.properties, level: piece.level }
          : l.feature.properties,
        geometry: { type: 'LineString', coordinates: w(piece.pts) },
      });
    }
  }
  features.length = 0;
  for (const f of out) features.push(f);
  return bridges;
}

/** Height at each point of a line, or undefined when none can be read. */
function heightsAlong(pts: P[], heights: Heights): number[] | undefined {
  const z = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)],
      b = pts[Math.min(pts.length - 1, i + 1)];
    return heights.at(p, unit(a, b));
  });
  const known = z.flatMap((v, i) => (v == null ? [] : [i]));
  if (!known.length) return undefined;
  // fill the gaps from the nearest known heights
  return z.map((v, i) => {
    if (v != null) return v;
    const before = known.filter(k => k < i).at(-1);
    const after = known.find(k => k > i);
    if (before == null) return z[after!]!;
    if (after == null) return z[before]!;
    return (
      z[before]! + ((z[after]! - z[before]!) * (i - before)) / (after - before)
    );
  });
}

/** The line cut into stretches of one level each. */
function splitByLevel(l: Line): { pts: P[]; level: number }[] {
  const total = l.s.at(-1)!;
  // stretch boundaries, merged where lifts overlap
  const cuts = new Set<number>([0, total]);
  for (const [from, to] of l.lifts) {
    cuts.add(Math.max(0, Math.min(total, from)));
    cuts.add(Math.max(0, Math.min(total, to)));
  }
  const at = [...cuts].sort((a, b) => a - b);
  const levelOf = (s: number) =>
    l.lifts.reduce(
      (lv, [from, to, level]) =>
        s > from && s < to ? Math.max(lv, level) : lv,
      0,
    );
  const pieces: { from: number; to: number; level: number }[] = [];
  for (let k = 1; k < at.length; k++) {
    if (at[k] - at[k - 1] < 0.01) continue;
    const level = levelOf((at[k - 1] + at[k]) / 2);
    const last = pieces.at(-1);
    if (last?.level === level) last.to = at[k];
    else pieces.push({ from: at[k - 1], to: at[k], level });
  }
  return pieces.map(({ from, to, level }) => ({
    pts: slice(l, from, to),
    level,
  }));
}

/** The part of a line between two distances along it. */
function slice(l: Line, from: number, to: number): P[] {
  const pointAt = (s: number): P => {
    let i = 1;
    while (i < l.s.length - 1 && l.s[i] < s) i++;
    const d = l.s[i] - l.s[i - 1];
    const t = d ? (s - l.s[i - 1]) / d : 0;
    const a = l.pts[i - 1],
      b = l.pts[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const out: P[] = [pointAt(from)];
  for (let i = 0; i < l.pts.length; i++) {
    if (l.s[i] > from && l.s[i] < to) out.push(l.pts[i]);
  }
  out.push(pointAt(to));
  return out;
}

/** Closest points of two segments, as fractions along each, and their distance. */
function closest(
  a: P,
  b: P,
  c: P,
  d: P,
): { t: number; u: number; d: number; sin: number } | undefined {
  const r: P = [b[0] - a[0], b[1] - a[1]];
  const q: P = [d[0] - c[0], d[1] - c[1]];
  const lr = Math.hypot(...r),
    lq = Math.hypot(...q);
  if (!lr || !lq) return undefined;
  const sin = Math.abs(r[0] * q[1] - r[1] * q[0]) / (lr * lq);
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) > 1e-9) {
    const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
    const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { t, u, d: 0, sin };
  }
  // no intersection: the closest pair has an end of one of the segments
  const options = [
    { ...project(c, a, b), u: 0 },
    { ...project(d, a, b), u: 1 },
  ].map(o => ({ t: o.t, u: o.u, d: o.d }));
  for (const [e, t] of [
    [a, 0],
    [b, 1],
  ] as const) {
    const o = project(e, c, d);
    options.push({ t, u: o.t, d: o.d });
  }
  const best = options.reduce((x, y) => (y.d < x.d ? y : x));
  return { ...best, sin };
}

function project(p: P, a: P, b: P): { t: number; d: number } {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    : 0;
  return { t, d: dist(p, [a[0] + t * dx, a[1] + t * dy]) };
}

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unit = (a: P, b: P): P => {
  const d = dist(a, b) || 1;
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
};
const length = (l: P[]) =>
  l.reduce((s, p, i) => (i ? s + dist(l[i - 1], p) : 0), 0);
