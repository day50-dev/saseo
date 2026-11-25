// The math behind the figures, apart from drawing them: number formats, axis ticks, sampling a
// plotted function, and laying out a graph's nodes. Pure, so it can be tested without a page.
import type { DataTable, NodeGraph, PlotSeries } from "../shared/canvas.ts";
import { fnOf } from "../shared/expr.ts";

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

/** "1,234", "12.5%", "1990s" → a number, when a cell holds one. */
export function asNumber(v: string | number | null): number | null {
  if (typeof v === "number") return v;
  if (v == null) return null;
  const m = v.replace(/[,\s]/g, "").match(/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i);
  return m ? Number(m[0]) : null;
}

/** Thousands grouped only from 10,000 up, so years (1788) read as years. */
export const cellNumber = (v: number) => (Math.abs(v) >= 10000 ? v.toLocaleString() : String(v));

export function guessChart(table: DataTable, numeric: boolean[]): DataTable["chart"] {
  const ys = numeric.map((n, i) => (n && i > 0 ? i : -1)).filter((i) => i > 0);
  if (!ys.length || table.rows.length < 2) return undefined;
  const xNumeric = table.rows.every((r) => asNumber(r[0]) !== null);
  return { x: 0, y: ys.slice(0, 4), kind: xNumeric ? "line" : "bar" };
}

/** Steps of 1, 2 or 5 times a power of ten, about `n` of them, covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, n = 6): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return out;
}

export type Line = [number, number][];

/** Each series as polylines (broken at gaps and asymptotes) in data coordinates, or as points. */
export function sample(s: PlotSeries, x0: number, x1: number): { lines: Line[]; dots: Line } {
  const N = 600;
  if (s.points) return s.line ? { lines: [s.points], dots: s.points.length <= 60 ? s.points : [] } : { lines: [], dots: s.points };
  const pts: [number, number][] = [];
  if (s.fn) {
    const f = fnOf(s.fn);
    if (f) for (let i = 0; i <= N; i++) {
      const x = x0 + ((x1 - x0) * i) / N;
      pts.push([x, f(x)]);
    }
  } else if (s.xt && s.yt) {
    const fx = fnOf(s.xt, "t");
    const fy = fnOf(s.yt, "t");
    const [t0, t1] = s.t ?? [0, 2 * Math.PI];
    if (fx && fy) for (let i = 0; i <= N; i++) {
      const t = t0 + ((t1 - t0) * i) / N;
      pts.push([fx(t), fy(t)]);
    }
  }
  const lines: Line[] = [];
  let cur: Line = [];
  for (const p of pts) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) cur.push(p);
    else if (cur.length) (lines.push(cur), (cur = []));
  }
  if (cur.length) lines.push(cur);
  return { lines, dots: [] };
}

/** Whole powers of ten across a log axis's range (given as logs). */
export function logTicks(a: number, b: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(a); k <= Math.floor(b); k++) out.push(k);
  return out.length >= 2 ? out : niceTicks(a, b, 4);
}

export type Pos = Record<string, { x: number; y: number }>;

/** The drawing the model gave (a named graph's standard one), when every node has a place. */
export function given(g: NodeGraph, W: number, H: number): Pos | null {
  if (!g.nodes.length || !g.nodes.every((n) => n.x !== undefined && n.y !== undefined)) return null;
  const pos: Pos = {};
  for (const n of g.nodes) pos[n.id] = { x: 50 + n.x! * (W - 100), y: 30 + n.y! * (H - 60) };
  return pos;
}

/** A directed graph with no cycles, in layers (a tree, a hierarchy, a flow); otherwise null. */
export function layered(g: NodeGraph, W: number, H: number): Pos | null {
  if (!g.directed) return null;
  const ins = new Map(g.nodes.map((n) => [n.id, [] as string[]]));
  for (const e of g.edges) if (e.from !== e.to) ins.get(e.to)!.push(e.from);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) throw new Error("cycle");
    visiting.add(id);
    const d = Math.max(-1, ...ins.get(id)!.map(depth)) + 1;
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  try {
    g.nodes.forEach((n) => depth(n.id));
  } catch {
    return null;
  }
  const rows: string[][] = [];
  for (const n of g.nodes) (rows[layer.get(n.id)!] ??= []).push(n.id);
  if (rows.some((r) => r.length > 7) && rows.length < 3) return null; // too wide to read in layers
  const pos: Pos = {};
  const place = () =>
    rows.forEach((r, i) =>
      r.forEach((id, k) => {
        pos[id] = { x: ((k + 0.5) / r.length) * W, y: rows.length === 1 ? H / 2 : 30 + (i / (rows.length - 1)) * (H - 60) };
      }),
    );
  place();
  // Order each layer under its parents, a couple of times over.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < rows.length; i++) {
      const at = (id: string) => {
        const ps = ins.get(id)!;
        return ps.length ? ps.reduce((s, p) => s + pos[p].x, 0) / ps.length : pos[id].x;
      };
      rows[i].sort((a, b) => at(a) - at(b));
    }
    place();
  }
  return pos;
}

/** Spring layout (Fruchterman–Reingold) for graphs without a hierarchy. Deterministic. */
export function springs(g: NodeGraph, W: number, H: number): Pos {
  const n = g.nodes.length;
  const p = g.nodes.map((_, i) => ({ x: W / 2 + (W / 3) * Math.cos((2 * Math.PI * i) / n), y: H / 2 + (H / 3) * Math.sin((2 * Math.PI * i) / n) }));
  const index = new Map(g.nodes.map((nd, i) => [nd.id, i]));
  const edges = g.edges.map((e) => [index.get(e.from)!, index.get(e.to)!]).filter(([a, b]) => a !== b);
  const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.75;
  let temp = W / 8;
  for (let it = 0; it < 400; it++) {
    const d = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        let dx = p[i].x - p[j].x;
        let dy = p[i].y - p[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) (dx = 0.01 * (i - j)), (dy = 0.01), (dist = 0.02);
        const f = (k * k) / dist;
        d[i].x += (dx / dist) * f;
        d[i].y += (dy / dist) * f;
        d[j].x -= (dx / dist) * f;
        d[j].y -= (dy / dist) * f;
      }
    for (const [a, b] of edges) {
      const dx = p[a].x - p[b].x;
      const dy = p[a].y - p[b].y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const f = (dist * dist) / k;
      d[a].x -= (dx / dist) * f;
      d[a].y -= (dy / dist) * f;
      d[b].x += (dx / dist) * f;
      d[b].y += (dy / dist) * f;
    }
    for (let i = 0; i < n; i++) {
      d[i].x += (W / 2 - p[i].x) * 0.02 * k / 10;
      d[i].y += (H / 2 - p[i].y) * 0.02 * k / 10;
      const len = Math.hypot(d[i].x, d[i].y) || 1;
      p[i].x += (d[i].x / len) * Math.min(len, temp);
      p[i].y += (d[i].y / len) * Math.min(len, temp);
    }
    temp = Math.max(0.5, temp * 0.985);
  }
  // Fit into the box.
  const xs = p.map((q) => q.x);
  const ys = p.map((q) => q.y);
  const [ax, bx, ay, by] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pos: Pos = {};
  g.nodes.forEach((nd, i) => {
    pos[nd.id] = {
      x: bx > ax ? 60 + ((p[i].x - ax) / (bx - ax)) * (W - 120) : W / 2,
      y: by > ay ? 30 + ((p[i].y - ay) / (by - ay)) * (H - 60) : H / 2,
    };
  });
  return pos;
}

/** A label in at most two lines of about `w` characters. */
export function wrap(label: string, w = 14): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [""];
  for (const word of words) {
    const cur = lines[lines.length - 1];
    if (cur && (cur + " " + word).length > w) lines.push(word);
    else lines[lines.length - 1] = cur ? `${cur} ${word}` : word;
  }
  return lines.length > 2 ? [lines[0], `${lines.slice(1).join(" ").slice(0, w - 1)}…`] : lines;
}
