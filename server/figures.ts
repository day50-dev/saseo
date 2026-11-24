// Figures a reader asks for: a table of data (read off real pages, credited), a plot of functions or
// points on axes, or a graph of nodes and edges. The model writes each as data, never as code; the
// page draws it. A redo ("log scale", "add cos x too") gets the previous version to change.
import type { DataTable, FoundSource, NodeGraph, Plot, PlotAxis, PlotSeries } from "../shared/canvas.ts";
import { fnOf } from "../shared/expr.ts";
import { loadConfig } from "./config.ts";
import { chatJson } from "./llm.ts";
import { readTables } from "./pages.ts";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

const MATH = `Write math in plain notation over the variable: x^2, 3x + 1, sin(x)/x, e^(-x^2), sqrt(x), abs(x), ln(x), log(x) (base 10), pi.
Functions: sin cos tan asin acos atan sinh cosh tanh exp ln log sqrt cbrt abs floor ceil sign min max gamma erf. No other names.`;

// ---- Tables of data ----

const TABLE = `You make a table of data for a reader studying a topic: the figures they asked for, read off the pages below.
Use only numbers and facts the pages state. Copy them exactly, with units in the column headers ("Population (millions)").
Keep cells numeric where the value is a number (no units or commas inside a numeric cell). Use null for a missing value.
At most 40 rows and 8 columns: pick the rows that answer the request. Order rows sensibly (by year, by size).
If the pages don't hold what was asked, you may fill the table from what you reliably know, but then set "fromMemory": true.
Say how it charts best: "x" is the column index along the bottom, "y" the column indices to plot (numeric columns only),
"kind": "line" for a series over time or a continuous quantity, "bar" for categories, "scatter" for two measurements against each other.
Return JSON only:
{"title": "...", "caption": "one sentence: what it shows and where it's from", "columns": ["..."], "rows": [[...]],
 "sources": [page numbers used], "fromMemory": false, "chart": {"x": 0, "y": [1], "kind": "line"}}`;

export async function makeTable(
  request: string,
  about: string,
  found: FoundSource[],
  previous?: DataTable,
): Promise<DataTable> {
  // Read the pages' tables (a few at once; one slow page doesn't hold up the rest).
  const read = await Promise.all(
    found.slice(0, 5).map((f) =>
      Promise.race([readTables(f.url), new Promise<null>((r) => setTimeout(() => r(null), 15000))]).catch(() => null),
    ),
  );
  const pages = read
    .map((p, i) => (p ? { ...p, title: found[i].title || p.title } : null))
    .filter((p): p is NonNullable<typeof p> => Boolean(p && (p.tables.length || p.prose)));
  const budget = 9000;
  const shown = pages.map((p, i) => {
    let tables = "";
    for (const t of p.tables) if (tables.length + t.length < budget) tables += `\n\n${t}`;
    return `[${i + 1}] ${p.title} (${p.url})\n${p.prose.slice(0, 1200)}${tables}`;
  });
  const r = await chatJson<Record<string, unknown>>((await loadConfig()).llm, [
    { role: "system", content: TABLE },
    {
      role: "user",
      content: [
        `They asked for: ${request}`,
        `The card it's about: ${about.slice(0, 1500)}`,
        previous && `The table they had, to change as they ask:\n${JSON.stringify({ title: previous.title, columns: previous.columns, rows: previous.rows.slice(0, 40) })}`,
        shown.length ? `Pages:\n\n${shown.join("\n\n---\n\n")}` : "No pages could be read.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]);
  const columns = (Array.isArray(r.columns) ? r.columns : []).map((c) => str(c).slice(0, 80)).slice(0, 8);
  if (!columns.length) throw new Error("Couldn't make a table of that. Try asking differently.");
  const rows = (Array.isArray(r.rows) ? r.rows : [])
    .filter(Array.isArray)
    .slice(0, 60)
    .map((row) =>
      columns.map((_, i) => {
        const v = (row as unknown[])[i];
        return typeof v === "number" ? (Number.isFinite(v) ? v : null) : v == null ? null : String(v).slice(0, 120);
      }),
    );
  if (!rows.length) throw new Error("No figures found for that. Try asking differently.");
  const used = (Array.isArray(r.sources) ? r.sources : []).map(Number).filter((n) => pages[n - 1]);
  const sources = [...new Set(used.length ? used : [])].map((n) => ({ title: pages[n - 1].title, url: pages[n - 1].url }));
  const c = (r.chart ?? {}) as Record<string, unknown>;
  const x = num(c.x);
  const ys = (Array.isArray(c.y) ? c.y : [c.y]).map(num).filter((i): i is number => i !== undefined && i >= 0 && i < columns.length && i !== x);
  const kind = (["line", "bar", "scatter"] as const).find((k) => k === c.kind) ?? "line";
  return {
    title: str(r.title).slice(0, 120) || request,
    caption: str(r.caption).slice(0, 400) || undefined,
    columns,
    rows,
    sources,
    ...(r.fromMemory === true || !sources.length ? { fromMemory: true } : {}),
    ...(x !== undefined && x >= 0 && x < columns.length && ys.length ? { chart: { x, y: ys, kind } } : {}),
  };
}

// ---- Plots on axes ----

const PLOT = `You plot mathematics for a reader studying a topic: functions, curves and points on Cartesian axes.
Plot what they asked for, in the context of the card. Choose ranges that show the interesting behavior (roots, peaks,
asymptotes, periods), and call out the key points with "marks" (computed correctly).
${MATH}
Each series is ONE of:
- a function: {"label": "y = sin(x)/x", "fn": "sin(x)/x"}
- a curve in t: {"label": "...", "xt": "cos(t)", "yt": "sin(t)", "t": [0, 6.2832]}
- points: {"label": "...", "points": [[x, y], ...], "line": true to join them}
At most 6 series. Labels are short and say what each is. Set "equal": true when shapes must not be stretched (circles, geometry).
Return JSON only:
{"title": "...", "caption": "one or two sentences on how to read it",
 "x": {"label": "x", "min": -10, "max": 10}, "y": {"label": "y"} (leave y's min and max out to fit the curves),
 "series": [...], "marks": [{"x": 0, "y": 1, "label": "..."}], "equal": false}`;

function axis(v: unknown): PlotAxis {
  const a = (v ?? {}) as Record<string, unknown>;
  const min = num(a.min);
  const max = num(a.max);
  const ok = min !== undefined && max !== undefined && max > min;
  return { label: str(a.label).slice(0, 60) || undefined, ...(ok ? { min, max } : {}), ...(a.log === true ? { log: true } : {}) };
}

export async function makePlot(request: string, about: string, previous?: { title: string; plot: Plot }): Promise<{ title: string; caption?: string; plot: Plot }> {
  const r = await chatJson<Record<string, unknown>>((await loadConfig()).llm, [
    { role: "system", content: PLOT },
    {
      role: "user",
      content: [`They asked for: ${request}`, `The card it's about: ${about.slice(0, 2000)}`, previous && `The plot they had, to change as they ask:\n${JSON.stringify(previous)}`]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]);
  const series: PlotSeries[] = [];
  const unread: string[] = [];
  for (const item of Array.isArray(r.series) ? r.series.slice(0, 8) : []) {
    const s = item as Record<string, unknown>;
    const label = str(s.label).slice(0, 80) || undefined;
    if (str(s.fn)) {
      if (fnOf(str(s.fn))) series.push({ label, fn: str(s.fn) });
      else unread.push(str(s.fn));
    } else if (str(s.xt) && str(s.yt)) {
      const t = Array.isArray(s.t) ? s.t.map(num) : [];
      const range: [number, number] = t[0] !== undefined && t[1] !== undefined && t[1] > t[0] ? [t[0], t[1]] : [0, 2 * Math.PI];
      if (fnOf(str(s.xt), "t") && fnOf(str(s.yt), "t")) series.push({ label, xt: str(s.xt), yt: str(s.yt), t: range });
      else unread.push(`${str(s.xt)}, ${str(s.yt)}`);
    } else if (Array.isArray(s.points)) {
      const points = s.points
        .map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : []))
        .filter((p): p is [number, number] => p.length === 2 && p[0] !== undefined && p[1] !== undefined)
        .slice(0, 2000);
      if (points.length) series.push({ label, points, ...(s.line === true ? { line: true } : {}) });
    }
  }
  if (!series.length) throw new Error(unread.length ? `Couldn't read the math the model wrote (${unread[0]}). Try again.` : "Nothing to plot came back. Try asking differently.");
  const marks = (Array.isArray(r.marks) ? r.marks : [])
    .map((m) => m as Record<string, unknown>)
    .map((m) => ({ x: num(m.x), y: num(m.y), label: str(m.label).slice(0, 60) }))
    .filter((m): m is { x: number; y: number; label: string } => m.x !== undefined && m.y !== undefined)
    .slice(0, 12);
  return {
    title: str(r.title).slice(0, 120) || request,
    caption: str(r.caption).slice(0, 400) || undefined,
    plot: { x: axis(r.x), y: axis(r.y), series, ...(marks.length ? { marks } : {}), ...(r.equal === true ? { equal: true } : {}) },
  };
}

// ---- Graphs of nodes and edges ----

const GRAPH = `You draw a graph of nodes and edges for a reader studying a topic: a graph in the mathematical sense
(a specific graph, a tree, a state machine, a lattice) or a network of how things connect (concepts, people, causes, dependencies).
Make what they asked for, in the context of the card. Get the structure right: for a named graph (K5, the Petersen graph,
a binary tree of depth 3), every node and edge it has. For a network, the things that matter and how each pair relates.
At most 40 nodes. Node labels are short (1 to 4 words); "note" says more, for a hover. Give nodes a "group" when they fall into kinds.
For a named graph with a standard drawing (the Petersen graph, a cube, K_n on a circle, a grid, a regular polygon),
give every node "x" and "y" between 0 and 1 (y downward) placing it as in that drawing.
Edge labels say how the two relate ("causes", "is a", "depends on"), or leave them out for a plain mathematical graph.
Return JSON only:
{"title": "...", "caption": "one or two sentences on how to read it", "directed": true | false,
 "nodes": [{"id": "a", "label": "...", "group": "...", "note": "..."}], "edges": [{"from": "a", "to": "b", "label": "..."}]}`;

export async function makeGraph(request: string, about: string, previous?: NodeGraph): Promise<NodeGraph> {
  const r = await chatJson<Record<string, unknown>>((await loadConfig()).llm, [
    { role: "system", content: GRAPH },
    {
      role: "user",
      content: [`They asked for: ${request}`, `The card it's about: ${about.slice(0, 2000)}`, previous && `The graph they had, to change as they ask:\n${JSON.stringify(previous)}`]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]);
  const nodes: NodeGraph["nodes"] = [];
  const ids = new Set<string>();
  for (const item of Array.isArray(r.nodes) ? r.nodes.slice(0, 60) : []) {
    const n = item as Record<string, unknown>;
    const id = str(n.id) || String(n.id ?? "");
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const x = num(n.x);
    const y = num(n.y);
    nodes.push({ id, label: (str(n.label) || id).slice(0, 60), ...(x !== undefined && y !== undefined ? { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) } : {}), ...(str(n.group) ? { group: str(n.group).slice(0, 40) } : {}), ...(str(n.note) ? { note: str(n.note).slice(0, 300) } : {}) });
  }
  const edges = (Array.isArray(r.edges) ? r.edges : [])
    .map((e) => e as Record<string, unknown>)
    .map((e) => ({ from: String(e.from ?? ""), to: String(e.to ?? ""), label: str(e.label).slice(0, 40) || undefined }))
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .slice(0, 200);
  if (!nodes.length) throw new Error("No graph came back. Try asking differently.");
  // Positions count only when every node has one.
  if (!nodes.every((n) => n.x !== undefined)) for (const n of nodes) delete n.x, delete n.y;
  return {
    title: str(r.title).slice(0, 120) || request,
    caption: str(r.caption).slice(0, 400) || undefined,
    ...(r.directed === true ? { directed: true } : {}),
    nodes,
    edges,
  };
}

