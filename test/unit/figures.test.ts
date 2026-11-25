// F-FIG and F-MAP: what Librarian keeps of what the model writes for a table, plot, graph or map.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, useEnv } from "../helpers/env.ts";

const llm = await fakeLlm();
useEnv(testEnv(llm.url));
const { makePlot, makeGraph, makeTable } = await import("../../server/figures.ts");
const { makeMap } = await import("../../server/maps.ts");
after(() => llm.close());

describe("F-FIG-2: plots", () => {
  test("keeps series it can read, ranges that make sense, and marks with numbers", async () => {
    llm.on(/You plot mathematics/, {
      title: "Sine and friends",
      caption: "How to read it",
      x: { label: "x", min: -6, max: 6 },
      y: { label: "y", min: 5, max: 1 }, // backwards: dropped, the plot fits the curves
      series: [
        { label: "sin", fn: "sin(x)" },
        { label: "bad", fn: "import os" },
        { label: "circle", xt: "cos(t)", yt: "sin(t)", t: [0, 6.28] },
        { label: "data", points: [[0, 1], ["2", "3"], [null, 1]], line: true },
      ],
      marks: [{ x: 0, y: 0, label: "root" }, { x: "a", y: 1, label: "bad" }],
      equal: true,
    }, 1);
    const r = await makePlot("plot sin x", "trig");
    assert.equal(r.title, "Sine and friends");
    assert.deepEqual(r.plot.series.map((s) => s.label), ["sin", "circle", "data"]);
    assert.deepEqual(r.plot.series[2].points, [[0, 1], [2, 3]]);
    assert.deepEqual(r.plot.x, { label: "x", min: -6, max: 6 });
    assert.deepEqual(r.plot.y, { label: "y" });
    assert.deepEqual(r.plot.marks, [{ x: 0, y: 0, label: "root" }]);
    assert.equal(r.plot.equal, true);
  });

  test("a function in t is accepted as a function", async () => {
    llm.on(/You plot mathematics/, { title: "c", series: [{ fn: "cos(t)" }] }, 1);
    assert.equal((await makePlot("cos t", "")).plot.series.length, 1);
  });

  test("fails plainly when nothing is readable", async () => {
    llm.on(/You plot mathematics/, { title: "c", series: [{ fn: "eval(x)" }] }, 1);
    await assert.rejects(makePlot("?", ""), /Couldn't read the math/);
  });

  test("a redo sends the plot it had", async () => {
    llm.on(/You plot mathematics/, { title: "c", series: [{ fn: "x" }] }, 1);
    await makePlot("log scale", "", { title: "before", plot: { x: {}, y: {}, series: [{ fn: "x^2" }] } });
    assert.match(llm.asked.at(-1)!.user, /The plot they had[\s\S]*x\^2/);
  });
});

describe("F-FIG-3: graphs", () => {
  test("drops duplicate nodes and edges to nowhere; keeps positions only if every node has one", async () => {
    llm.on(/You draw a graph of nodes and edges/, {
      title: "K3",
      directed: false,
      nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 2, y: 0.5 }, { id: "a" }, { id: "c" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "zz" }],
    }, 1);
    const g = await makeGraph("K3", "");
    assert.deepEqual(g.nodes.map((n) => n.id), ["a", "b", "c"]);
    assert.ok(g.nodes.every((n) => n.x === undefined));
    assert.deepEqual(g.edges.map((e) => `${e.from}${e.to}`), ["ab"]);
    assert.equal(g.directed, undefined);
  });

  test("positions are clamped to the unit square", async () => {
    llm.on(/You draw a graph of nodes and edges/, { title: "t", directed: true, nodes: [{ id: "a", x: -1, y: 0 }, { id: "b", x: 2, y: 1 }], edges: [] }, 1);
    const g = await makeGraph("t", "");
    assert.deepEqual(g.nodes.map((n) => [n.x, n.y]), [[0, 0], [1, 1]]);
    assert.equal(g.directed, true);
  });
});

describe("F-FIG-1: tables", () => {
  test("with no pages read, a table is flagged as from the model's memory", async () => {
    llm.on(/You make a table of data/, { title: "Populations", columns: ["city", "pop"], rows: [["Paris", 2.1], ["Turin", 0.8, "extra"], "not a row"], sources: [1], chart: { x: 0, y: [1, 0, 9], kind: "bar" } }, 1);
    const t = await makeTable("populations", "", []);
    assert.deepEqual(t.rows, [["Paris", 2.1], ["Turin", 0.8]]);
    assert.deepEqual(t.sources, []);
    assert.equal(t.fromMemory, true);
    assert.deepEqual(t.chart, { x: 0, y: [1], kind: "bar" });
    assert.match(llm.asked.at(-1)!.user, /No pages could be read/);
  });

  test("no columns or rows is an error, said plainly", async () => {
    llm.on(/You make a table of data/, { title: "x", columns: [], rows: [] }, 1);
    await assert.rejects(makeTable("x", "", []), /Couldn't make a table/);
  });
});

describe("F-MAP: maps", () => {
  const real = globalThis.fetch;
  const geocoded: string[] = [];
  const places: Record<string, [number, number] | null> = {
    "Turin, Italy": [45.07, 7.69],
    "Berlin, Germany": [52.52, 13.4],
    "Paris, France": [29.0, -95.0], // Paris, Texas: far from the model's guess
    Paris: [29.0, -95.0],
    "Nowhere, Atlantis": null,
    Atlantis: null,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://nominatim.openstreetmap.org/")) return real(input, init);
    const q = new URL(url).searchParams.get("q")!;
    geocoded.push(`${q}|${(init?.headers as Record<string, string>)["User-Agent"]}`);
    if (q === "France") return Response.json([{ lat: "46", lon: "2", geojson: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }]);
    const at = places[q];
    return Response.json(at ? [{ lat: String(at[0]), lon: String(at[1]) }] : []);
  }) as typeof fetch;
  after(() => (globalThis.fetch = real));

  test("places come from the geocoder; a far-off or missing hit falls back to the model's guess, flagged", async () => {
    llm.on(/You make a map/, {
      title: "Lagrange",
      route: true,
      places: [
        { name: "Turin", query: "Turin, Italy", lat: 45, lon: 7.7, note: "born" },
        { name: "Berlin", query: "Berlin, Germany", lat: 52.5, lon: 13.4 },
        { name: "Paris", query: "Paris, France", lat: 48.86, lon: 2.35 },
        { name: "Atlantis", query: "Nowhere, Atlantis" },
      ],
      areas: [{ name: "France", group: "home" }, "Mordor"],
    }, 1);
    const stages: string[] = [];
    const m = await makeMap("map Lagrange's life", "Lagrange", undefined, (s) => stages.push(s));
    assert.deepEqual(stages, ["searching"]);
    assert.deepEqual(m.places.map((p) => [p.name, p.lat, p.approximate ?? false]), [
      ["Turin", 45.07, false],
      ["Berlin", 52.52, false],
      ["Paris", 48.86, true],
    ]);
    assert.equal(m.route, true);
    assert.deepEqual(m.areas!.map((a) => a.name), ["France"]);
    assert.deepEqual(m.missing, ["Atlantis", "Mordor"]);
    assert.ok(geocoded.every((g) => g.endsWith("|Librarian/1.0 (study canvas)")), "identifies itself to the geocoder");
  });
});
