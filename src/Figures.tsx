// Figures on object cards: a table of data (which can chart itself), a plot of functions, curves and
// points on axes, and a graph of nodes and edges. All drawn here from data; the model's math is
// parsed by shared/expr.ts, never run.
import { useMemo, useRef, useState } from "react";
import type { DataTable, NodeGraph, Plot, PlotSeries } from "../shared/canvas.ts";
import { fnOf } from "../shared/expr.ts";

const COLORS = 6;
const color = (i: number) => `var(--fig-${(i % COLORS) + 1})`;
const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();

/** Lets a scrolling box scroll under the wheel instead of panning the canvas, when it has room to. */
function scrollable(e: React.WheelEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (e.ctrlKey || e.metaKey) return;
  if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) e.stopPropagation();
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

/** "1,234", "12.5%", "1990s" → a number, when a cell holds one. */
function asNumber(v: string | number | null): number | null {
  if (typeof v === "number") return v;
  if (v == null) return null;
  const m = v.replace(/[,\s]/g, "").match(/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i);
  return m ? Number(m[0]) : null;
}

// ---- A table of data ----

/** Thousands grouped only from 10,000 up, so years (1788) read as years. */
const cellNumber = (v: number) => (Math.abs(v) >= 10000 ? v.toLocaleString() : String(v));

export function TableView({ table }: { table: DataTable }) {
  const [chart, setChart] = useState(false);
  const [copied, setCopied] = useState(false);
  const numeric = table.columns.map((_, i) => table.rows.every((r) => r[i] == null || typeof r[i] === "number"));
  const spec = table.chart ?? guessChart(table, numeric);
  const csv = () =>
    [table.columns, ...table.rows]
      .map((r) => r.map((v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(","))
      .join("\n");
  return (
    <div className="figure figure-table" onPointerDown={stop}>
      {table.caption && <p className="small figure-caption">{table.caption}</p>}
      {table.fromMemory && (
        <p className="small figure-warn">
          {table.sources.length
            ? "Partly from the model's memory: check any figure the pages below don't show."
            : "From the model's memory: no page it read held these figures. Check them before relying on them."}
        </p>
      )}
      <div className="figure-tools">
        {spec && (
          <button type="button" className={`secondary${chart ? " on" : ""}`} onClick={() => setChart(!chart)}>
            {chart ? "Show the table" : "Chart it"}
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(csv()).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy as CSV"}
        </button>
      </div>
      {chart && spec ? (
        <TableChart table={table} spec={spec} />
      ) : (
        <div className="figure-table-wrap" onWheel={scrollable}>
          <table>
            <thead>
              <tr>
                {table.columns.map((c, i) => (
                  <th key={i} className={numeric[i] ? "num" : ""} data-f={`the column "${c}" of the table`}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} data-f={`row ${i + 1} of the table: ${r.map((v, j) => `${table.columns[j]} ${v ?? "–"}`).join(", ")}`}>
                  {r.map((v, j) => (
                    <td key={j} className={typeof v === "number" ? "num" : ""}>
                      {v == null ? <span className="muted">–</span> : typeof v === "number" ? cellNumber(v) : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table.sources.length > 0 && (
        <p className="small muted figure-sources">
          From:{" "}
          {table.sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && " · "}
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.title}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function guessChart(table: DataTable, numeric: boolean[]): DataTable["chart"] {
  const ys = numeric.map((n, i) => (n && i > 0 ? i : -1)).filter((i) => i > 0);
  if (!ys.length || table.rows.length < 2) return undefined;
  const xNumeric = table.rows.every((r) => asNumber(r[0]) !== null);
  return { x: 0, y: ys.slice(0, 4), kind: xNumeric ? "line" : "bar" };
}

function TableChart({ table, spec }: { table: DataTable; spec: NonNullable<DataTable["chart"]> }) {
  const xs = table.rows.map((r) => asNumber(r[spec.x]));
  // Categories (or a bar chart asked for): bars. Numbers along the bottom: points on axes.
  if (spec.kind === "bar" || xs.some((x) => x === null)) {
    const cats = table.rows.map((r) => String(r[spec.x] ?? ""));
    const series = spec.y.map((c) => ({ label: table.columns[c], values: table.rows.map((r) => asNumber(r[c])) }));
    return <Bars cats={cats} series={series} xLabel={table.columns[spec.x]} />;
  }
  const plot: Plot = {
    x: { label: table.columns[spec.x] },
    y: { label: spec.y.length === 1 ? table.columns[spec.y[0]] : undefined },
    series: spec.y.map((c) => ({
      label: table.columns[c],
      line: spec.kind === "line",
      points: table.rows
        .map((r, i) => [xs[i], asNumber(r[c])] as const)
        .filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null)
        .map((p) => [p[0], p[1]] as [number, number])
        .sort((a, b) => a[0] - b[0]),
    })),
  };
  return <PlotSvg plot={plot} />;
}

function Bars({ cats, series, xLabel }: { cats: string[]; series: { label: string; values: (number | null)[] }[]; xLabel: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 480;
  const H = 300;
  const m = { l: 48, r: 10, t: 10, b: cats.some((c) => c.length > 6) ? 70 : 30 };
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all) || 1;
  const ticks = niceTicks(lo, hi, 5);
  const y0 = Math.min(lo, ticks[0]);
  const y1 = Math.max(hi, ticks[ticks.length - 1]);
  const Y = (v: number) => m.t + ((y1 - v) / (y1 - y0)) * (H - m.t - m.b);
  const band = (W - m.l - m.r) / Math.max(1, cats.length);
  const bw = Math.min(40, (band * 0.8) / series.length);
  return (
    <>
      <svg className="figure-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={xLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={Y(t)} y2={Y(t)} className={t === 0 ? "fig-axis" : "fig-grid"} />
            <text x={m.l - 6} y={Y(t) + 4} textAnchor="end" className="fig-tick">
              {fmt(t)}
            </text>
          </g>
        ))}
        {cats.map((c, i) => {
          const cx = m.l + band * (i + 0.5);
          return (
            <g key={i}>
              {series.map((s, k) => {
                const v = s.values[i];
                if (v === null) return null;
                const x = cx - (bw * series.length) / 2 + k * bw;
                return (
                  <rect
                    key={k}
                    x={x}
                    width={bw - 1}
                    y={Math.min(Y(v), Y(0))}
                    height={Math.abs(Y(v) - Y(0))}
                    fill={color(k)}
                    data-f={`the bar for ${c}: ${s.label} ${cellNumber(v)}`}
                    onMouseEnter={() => setHover(`${c}: ${s.label} ${cellNumber(v)}`)}
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
              <text
                className="fig-tick"
                x={cx}
                y={H - m.b + 14}
                textAnchor={m.b > 30 ? "end" : "middle"}
                transform={m.b > 30 ? `rotate(-40 ${cx} ${H - m.b + 14})` : undefined}
              >
                {c.length > 16 ? `${c.slice(0, 15)}…` : c}
              </text>
            </g>
          );
        })}
      </svg>
      <Legend labels={series.map((s) => s.label)} readout={hover} />
    </>
  );
}

function Legend({ labels, readout }: { labels: (string | undefined)[]; readout?: string | null }) {
  const shown = labels.map((l, i) => [l, i] as const).filter(([l]) => l);
  return (
    <div className="figure-legend small">
      {shown.length > 1 || (shown.length === 1 && !readout)
        ? shown.map(([l, i]) => (
            <span key={i}>
              <i style={{ background: color(i) }} />
              {l}
            </span>
          ))
        : null}
      {readout && <span className="figure-readout">{readout}</span>}
    </div>
  );
}

// ---- A plot on axes ----

export function PlotView({ title, caption, plot }: { title: string; caption?: string; plot: Plot }) {
  return (
    <div className="figure figure-plot" onPointerDown={stop}>
      <PlotSvg plot={plot} title={title} />
      {caption && <p className="small figure-caption">{caption}</p>}
    </div>
  );
}

/** Steps of 1, 2 or 5 times a power of ten, about `n` of them, covering [lo, hi]. */
function niceTicks(lo: number, hi: number, n = 6): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return out;
}

type Line = [number, number][];

/** Each series as polylines (broken at gaps and asymptotes) in data coordinates, or as points. */
function sample(s: PlotSeries, x0: number, x1: number): { lines: Line[]; dots: Line } {
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

function PlotSvg({ plot, title }: { plot: Plot; title?: string }) {
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 480;
  const m = { l: 46, r: 12, t: 12, b: 36 };

  const drawn = useMemo(() => {
    const lx = (v: number) => (plot.x.log ? (v > 0 ? Math.log10(v) : NaN) : v);
    const ly = (v: number) => (plot.y.log ? (v > 0 ? Math.log10(v) : NaN) : v);
    // x's range: as asked; else what the points and curves span; else -10 to 10.
    const known: number[] = [];
    for (const s of plot.series) {
      if (s.points) known.push(...s.points.map((p) => p[0]));
      if (s.xt) known.push(...sample(s, 0, 1).lines.flat().map((p) => p[0]));
    }
    for (const mk of plot.marks ?? []) known.push(mk.x);
    let x0 = plot.x.min ?? (known.length ? Math.min(...known) : -10);
    let x1 = plot.x.max ?? (known.length ? Math.max(...known) : 10);
    if (plot.x.min === undefined && plot.x.max === undefined && known.length) {
      const pad = (x1 - x0 || 2) * (plot.series.some((s) => s.fn) ? 0.1 : 0.04);
      x0 -= pad;
      x1 += pad;
    }
    if (!(x1 > x0)) (x0 -= 1), (x1 += 1);
    const each = plot.series.map((s) => sample(s, x0, x1));
    // y's range: as asked; else fit what's drawn, ignoring the far reaches of asymptotes.
    let y0: number;
    let y1: number;
    if (plot.y.min !== undefined && plot.y.max !== undefined) {
      y0 = ly(plot.y.min);
      y1 = ly(plot.y.max);
    } else {
      const ys = each.flatMap((e) => [...e.lines.flat(), ...e.dots].filter((p) => p[0] >= x0 - 1e-9 && p[0] <= x1 + 1e-9 || plot.series.some((s) => s.xt)).map((p) => ly(p[1]))).filter(Number.isFinite).sort((a, b) => a - b);
      for (const mk of plot.marks ?? []) ys.push(ly(mk.y));
      ys.sort((a, b) => a - b);
      if (!ys.length) (y0 = -1), (y1 = 1);
      else {
        y0 = ys[0];
        y1 = ys[ys.length - 1];
        const q = (f: number) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(f * (ys.length - 1))))];
        const lo = q(0.03);
        const hi = q(0.97);
        if (y1 - y0 > 8 * (hi - lo) && hi > lo) {
          y0 = Math.min(lo, ...(plot.marks ?? []).map((k) => ly(k.y)));
          y1 = Math.max(hi, ...(plot.marks ?? []).map((k) => ly(k.y)));
        }
        const pad = (y1 - y0 || 2) * 0.08;
        y0 -= pad;
        y1 += pad;
      }
    }
    const X0 = lx(x0);
    const X1 = lx(x1);
    let H = 320;
    if (plot.equal) {
      // Same units per pixel both ways: the height follows, within reason, then the ranges widen.
      const pw = W - m.l - m.r;
      H = Math.round(Math.min(520, Math.max(200, (pw * (y1 - y0)) / (X1 - X0) + m.t + m.b)));
      const ph = H - m.t - m.b;
      const upp = Math.max((X1 - X0) / pw, (y1 - y0) / ph);
      const cy = (y0 + y1) / 2;
      y0 = cy - (upp * ph) / 2;
      y1 = cy + (upp * ph) / 2;
    }
    const sx = (v: number) => m.l + ((lx(v) - X0) / (X1 - X0)) * (W - m.l - m.r);
    const sy = (v: number) => m.t + ((y1 - ly(v)) / (y1 - y0)) * (H - m.t - m.b);
    const span = y1 - y0;
    const path = (line: Line) => {
      let d = "";
      let prev: number | null = null;
      for (const [x, y] of line) {
        const Y = ly(y);
        const X = lx(x);
        if (!Number.isFinite(Y) || !Number.isFinite(X)) {
          prev = null;
          continue;
        }
        // A jump across most of the view between neighbors is an asymptote, not a line.
        const jump = prev !== null && Math.abs(Y - prev) > span * 1.5 && (Y > y1 || Y < y0 || prev > y1 || prev < y0);
        const cy = Math.max(y0 - span, Math.min(y1 + span, Y));
        d += `${d && !jump && prev !== null ? "L" : "M"}${sx(x).toFixed(1)},${(m.t + ((y1 - cy) / span) * (H - m.t - m.b)).toFixed(1)}`;
        prev = Y;
      }
      return d;
    };
    const ticksX = plot.x.log ? logTicks(X0, X1) : niceTicks(x0, x1, 6);
    const ticksY = plot.y.log ? logTicks(y0, y1) : niceTicks(y0, y1, 5);
    return { each, path, sx, sy, H, ticksX, ticksY, x0, x1, y0, y1, X0, X1 };
  }, [plot]);

  const { each, path, sx, sy, H, ticksX, ticksY, X0, X1, y0, y1 } = drawn;
  const inX = (v: number) => (plot.x.log ? Math.log10(v) : v) >= X0 && (plot.x.log ? Math.log10(v) : v) <= X1;
  const inY = (v: number) => (plot.y.log ? Math.log10(v) : v) >= y0 && (plot.y.log ? Math.log10(v) : v) <= y1;
  const zeroX = !plot.x.log && inX(0) ? sx(0) : null;
  const zeroY = !plot.y.log && inY(0) ? sy(0) : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < m.l || px > W - m.r) return setHover(null);
    const t = X0 + ((px - m.l) / (W - m.l - m.r)) * (X1 - X0);
    const x = plot.x.log ? Math.pow(10, t) : t;
    const parts: string[] = [`x = ${fmt(x)}`];
    plot.series.forEach((s, i) => {
      if (s.fn) {
        const f = fnOf(s.fn);
        const y = f ? f(x) : NaN;
        if (Number.isFinite(y)) parts.push(`${plot.series.length > 1 ? `${s.label ?? `#${i + 1}`}: ` : "y = "}${fmt(y)}`);
      } else if (s.points?.length) {
        const near = s.points.reduce((a, b) => (Math.abs(b[0] - x) < Math.abs(a[0] - x) ? b : a));
        if (Math.abs(sx(near[0]) - px) < 12) parts.push(`${s.label ? `${s.label}: ` : ""}(${fmt(near[0])}, ${fmt(near[1])})`);
      }
    });
    setHover({ x: px, text: parts.join("   ") });
    // For a call: what's under the pointer, in the plot's terms.
    svgRef.current!.dataset.f = `the plot at ${parts.join(", ")}`;
  };

  return (
    <>
      <svg ref={svgRef} className="figure-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => (setHover(null), delete svgRef.current?.dataset.f)}>
        <defs>
          <clipPath id={`clip-${H}`}>
            <rect x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} />
          </clipPath>
        </defs>
        {ticksX.map((t) => {
          const v = plot.x.log ? Math.pow(10, t) : t;
          return (
            <g key={`x${t}`}>
              <line x1={sx(v)} x2={sx(v)} y1={m.t} y2={H - m.b} className="fig-grid" />
              <text x={sx(v)} y={H - m.b + 14} textAnchor="middle" className="fig-tick">
                {fmt(v)}
              </text>
            </g>
          );
        })}
        {ticksY.map((t) => {
          const v = plot.y.log ? Math.pow(10, t) : t;
          return (
            <g key={`y${t}`}>
              <line x1={m.l} x2={W - m.r} y1={sy(v)} y2={sy(v)} className="fig-grid" />
              <text x={m.l - 6} y={sy(v) + 4} textAnchor="end" className="fig-tick">
                {fmt(v)}
              </text>
            </g>
          );
        })}
        <rect x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} className="fig-frame" />
        {zeroX !== null && <line x1={zeroX} x2={zeroX} y1={m.t} y2={H - m.b} className="fig-axis" />}
        {zeroY !== null && <line x1={m.l} x2={W - m.r} y1={zeroY} y2={zeroY} className="fig-axis" />}
        <g clipPath={`url(#clip-${H})`}>
          {each.map((e, i) => (
            <g key={i} stroke={color(i)} fill={color(i)}>
              {e.lines.map((l, k) => (
                <path key={k} d={path(l)} fill="none" strokeWidth={2} strokeLinejoin="round" />
              ))}
              {e.dots.map(([x, y], k) =>
                Number.isFinite(sy(y)) ? <circle key={k} cx={sx(x)} cy={sy(y)} r={e.dots.length > 200 ? 1.6 : 3} stroke="none" /> : null,
              )}
            </g>
          ))}
          {(plot.marks ?? []).map((mk, i) => (
            <g key={i} className="fig-mark">
              <circle cx={sx(mk.x)} cy={sy(mk.y)} r={4} />
              <text x={sx(mk.x) + 7} y={sy(mk.y) - 7}>
                {mk.label}
              </text>
            </g>
          ))}
          {hover && <line x1={hover.x} x2={hover.x} y1={m.t} y2={H - m.b} className="fig-cursor" />}
        </g>
        {plot.x.label && (
          <text x={(m.l + W - m.r) / 2} y={H - 4} textAnchor="middle" className="fig-label">
            {plot.x.label}
          </text>
        )}
        {plot.y.label && (
          <text x={12} y={(m.t + H - m.b) / 2} textAnchor="middle" className="fig-label" transform={`rotate(-90 12 ${(m.t + H - m.b) / 2})`}>
            {plot.y.label}
          </text>
        )}
      </svg>
      <Legend labels={plot.series.map((s) => s.label)} readout={hover?.text} />
    </>
  );
}

/** Whole powers of ten across a log axis's range (given as logs). */
function logTicks(a: number, b: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(a); k <= Math.floor(b); k++) out.push(k);
  return out.length >= 2 ? out : niceTicks(a, b, 4);
}

// ---- A graph of nodes and edges ----

type Pos = Record<string, { x: number; y: number }>;

/** The drawing the model gave (a named graph's standard one), when every node has a place. */
function given(g: NodeGraph, W: number, H: number): Pos | null {
  if (!g.nodes.length || !g.nodes.every((n) => n.x !== undefined && n.y !== undefined)) return null;
  const pos: Pos = {};
  for (const n of g.nodes) pos[n.id] = { x: 50 + n.x! * (W - 100), y: 30 + n.y! * (H - 60) };
  return pos;
}

/** A directed graph with no cycles, in layers (a tree, a hierarchy, a flow); otherwise null. */
function layered(g: NodeGraph, W: number, H: number): Pos | null {
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
function springs(g: NodeGraph, W: number, H: number): Pos {
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
function wrap(label: string, w = 14): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [""];
  for (const word of words) {
    const cur = lines[lines.length - 1];
    if (cur && (cur + " " + word).length > w) lines.push(word);
    else lines[lines.length - 1] = cur ? `${cur} ${word}` : word;
  }
  return lines.length > 2 ? [lines[0], `${lines.slice(1).join(" ").slice(0, w - 1)}…`] : lines;
}

export function GraphView({ graph }: { graph: NodeGraph }) {
  const W = 480;
  const H = Math.min(520, Math.max(300, graph.nodes.length * 14));
  const start = useMemo(() => given(graph, W, H) ?? layered(graph, W, H) ?? springs(graph, W, H), [graph, H]);
  const [moved, setMoved] = useState<Pos>({});
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pos = (id: string) => moved[id] ?? start[id];
  const groups = [...new Set(graph.nodes.map((n) => n.group).filter(Boolean))] as string[];
  const fill = (n: NodeGraph["nodes"][number]) => (n.group ? color(groups.indexOf(n.group)) : color(0));
  const near = new Set<string>();
  if (hover) {
    near.add(hover);
    for (const e of graph.edges) {
      if (e.from === hover) near.add(e.to);
      if (e.to === hover) near.add(e.from);
    }
  }
  const toSvg = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const box = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id)!;
    const lines = wrap(n.label);
    return { w: Math.max(28, Math.max(...lines.map((l) => l.length)) * 6.4 + 14), h: lines.length * 13 + 10, lines };
  };
  // Where an edge meets a node's box, so arrowheads sit on the edge of it.
  const rim = (from: { x: number; y: number }, to: { x: number; y: number }, b: { w: number; h: number }) => {
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    const s = Math.min(Math.abs(b.w / 2 / (dx || 1e-9)), Math.abs(b.h / 2 / (dy || 1e-9)));
    return { x: to.x + dx * Math.min(1, s), y: to.y + dy * Math.min(1, s) };
  };
  const hovered = graph.nodes.find((n) => n.id === hover);
  return (
    <div className="figure figure-graph" onPointerDown={stop}>
      <svg
        ref={svgRef}
        className="figure-svg"
        viewBox={`0 0 ${W} ${H}`}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const p = toSvg(e);
          const { id, dx, dy } = drag.current;
          setMoved((m) => ({ ...m, [id]: { x: Math.max(10, Math.min(W - 10, p.x + dx)), y: Math.max(10, Math.min(H - 10, p.y + dy)) } }));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <defs>
          <marker id="fig-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="fig-arrowhead" />
          </marker>
        </defs>
        {graph.edges.map((e, i) => {
          const a = pos(e.from);
          const b = pos(e.to);
          if (!a || !b) return null;
          const dim = hover && !(e.from === hover || e.to === hover);
          if (e.from === e.to) {
            const bb = box(e.from);
            return <circle key={i} cx={a.x + bb.w / 2} cy={a.y - bb.h / 2} r={9} className={`fig-edge${dim ? " dim" : ""}`} fill="none" />;
          }
          const end = rim(a, b, box(e.to));
          const begin = rim(b, a, box(e.from));
          return (
            <g key={i} className={`fig-edge${dim ? " dim" : ""}`} data-f={`the edge from "${graph.nodes.find((n) => n.id === e.from)?.label}" to "${graph.nodes.find((n) => n.id === e.to)?.label}"${e.label ? ` (${e.label})` : ""}`}>
              <line x1={begin.x} y1={begin.y} x2={end.x} y2={end.y} markerEnd={graph.directed ? "url(#fig-arrow)" : undefined} />
              {e.label && (
                // Nearer the source than the middle: edges that meet at one node keep their labels apart.
                <text x={begin.x + (end.x - begin.x) * 0.4} y={begin.y + (end.y - begin.y) * 0.4 - 3} textAnchor="middle" className="fig-edge-label">
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {graph.nodes.map((n) => {
          const p = pos(n.id);
          const b = box(n.id);
          return (
            <g
              key={n.id}
              className={`fig-node${hover && !near.has(n.id) ? " dim" : ""}`}
              data-f={`the node "${n.label}"${n.group ? ` (${n.group})` : ""}, linked to ${graph.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => graph.nodes.find((x) => x.id === (e.from === n.id ? e.to : e.from))?.label).filter(Boolean).join(", ") || "nothing"}`}
              transform={`translate(${p.x} ${p.y})`}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => !drag.current && setHover(null)}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
                const q = toSvg(e);
                drag.current = { id: n.id, dx: p.x - q.x, dy: p.y - q.y };
              }}
            >
              <rect x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} rx={b.h / 2} style={{ stroke: fill(n) }} />
              {b.lines.map((l, i) => (
                <text key={i} y={(i - (b.lines.length - 1) / 2) * 13 + 4} textAnchor="middle">
                  {l}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="figure-legend small">
        {groups.length > 1 &&
          groups.map((g, i) => (
            <span key={g}>
              <i style={{ background: color(i) }} />
              {g}
            </span>
          ))}
        <span className="figure-readout">
          {hovered ? `${hovered.label}${hovered.note ? `: ${hovered.note}` : ""}` : Object.keys(moved).length ? "" : "Drag the nodes to rearrange them."}
        </span>
        {Object.keys(moved).length > 0 && (
          <button type="button" className="link small" onClick={() => setMoved({})}>
            Reset layout
          </button>
        )}
      </div>
      {graph.caption && <p className="small figure-caption">{graph.caption}</p>}
    </div>
  );
}
