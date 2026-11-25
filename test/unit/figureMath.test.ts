// F-FIG: the math under tables, plots and graphs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asNumber, cellNumber, fmt, given, guessChart, layered, logTicks, niceTicks, sample, springs, wrap } from "../../src/figureMath.ts";
import type { NodeGraph } from "../../shared/canvas.ts";

describe("F-FIG-1: tables", () => {
  test("cells read as numbers when they hold one", () => {
    assert.equal(asNumber("1,234"), 1234);
    assert.equal(asNumber("12.5%"), 12.5);
    assert.equal(asNumber("1990s"), 1990);
    assert.equal(asNumber("-3e2"), -300);
    assert.equal(asNumber("about 5"), null);
    assert.equal(asNumber(null), null);
    assert.equal(asNumber(7), 7);
  });

  test("years stay years; big numbers are grouped", () => {
    assert.equal(cellNumber(1788), "1788");
    assert.equal(cellNumber(12345), (12345).toLocaleString());
  });

  test("a table charts as a line over numbers, bars over names", () => {
    const years = { title: "", columns: ["year", "pop", "note"], rows: [[1900, 5, "a"], [1950, 9, "b"]], sources: [] };
    assert.deepEqual(guessChart(years, [true, true, false]), { x: 0, y: [1], kind: "line" });
    const cities = { title: "", columns: ["city", "pop"], rows: [["Paris", 2], ["Turin", 1]], sources: [] };
    assert.deepEqual(guessChart(cities, [false, true]), { x: 0, y: [1], kind: "bar" });
    assert.equal(guessChart({ ...cities, rows: [["Paris", 2]] }, [false, true]), undefined); // one row
    assert.equal(guessChart(cities, [false, false]), undefined); // nothing numeric
  });
});

describe("F-FIG-2: plots", () => {
  test("number labels", () => {
    assert.equal(fmt(0.5), "0.5");
    assert.equal(fmt(1 / 3), "0.3333");
    assert.equal(fmt(2e7), "2.00e+7");
    assert.equal(fmt(0.0001), "1.00e-4");
    assert.equal(fmt(0), "0");
  });

  test("ticks fall on round numbers and cover the range", () => {
    assert.deepEqual(niceTicks(0, 10), [0, 2, 4, 6, 8, 10]);
    assert.deepEqual(niceTicks(-1, 1, 4), [-1, -0.5, 0, 0.5, 1]);
    const t = niceTicks(-3.7, 12.2);
    assert.ok(t[0] >= -3.7 && t.at(-1)! <= 12.2 && t.includes(0));
    assert.deepEqual(niceTicks(5, 5), [5]);
    assert.deepEqual(logTicks(0, 3), [0, 1, 2, 3]);
  });

  test("a function is sampled and broken at asymptotes", () => {
    const { lines } = sample({ fn: "1/x" }, -1, 1);
    assert.equal(lines.length, 2, "1/x breaks at 0");
    const tan = sample({ fn: "sqrt(x)" }, -1, 1);
    assert.ok(tan.lines.every((l) => l.every(([x]) => x >= 0)), "no points where it's undefined");
  });

  test("a curve in t", () => {
    const { lines } = sample({ xt: "cos(t)", yt: "sin(t)", t: [0, Math.PI] }, 0, 0);
    const [first, last] = [lines[0][0], lines[0].at(-1)!];
    assert.ok(Math.abs(first[0] - 1) < 1e-9 && Math.abs(last[0] + 1) < 1e-9);
  });

  test("points, joined or not", () => {
    const pts: [number, number][] = [[0, 0], [1, 1]];
    assert.deepEqual(sample({ points: pts }, 0, 1), { lines: [], dots: pts });
    assert.deepEqual(sample({ points: pts, line: true }, 0, 1).lines, [pts]);
  });
});

describe("F-FIG-3: graph layouts", () => {
  const tree: NodeGraph = {
    title: "",
    directed: true,
    nodes: ["a", "b", "c", "d"].map((id) => ({ id, label: id })),
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
    ],
  };

  test("a hierarchy is drawn in layers, parents above children", () => {
    const p = layered(tree, 600, 400)!;
    assert.ok(p.a.y < p.b.y && p.b.y < p.d.y);
    assert.equal(p.b.y, p.c.y);
  });

  test("a cycle or an undirected graph isn't layered", () => {
    assert.equal(layered({ ...tree, edges: [...tree.edges, { from: "d", to: "a" }] }, 600, 400), null);
    assert.equal(layered({ ...tree, directed: false }, 600, 400), null);
  });

  test("the model's own drawing is used only when every node has a place", () => {
    const placed = { ...tree, nodes: tree.nodes.map((n, i) => ({ ...n, x: i / 3, y: 0.5 })) };
    const p = given(placed, 600, 400)!;
    assert.equal(p.a.x, 50);
    assert.equal(p.d.x, 550);
    assert.equal(given({ ...placed, nodes: [...placed.nodes.slice(1), { id: "a", label: "a" }] }, 600, 400), null);
  });

  test("springs: deterministic, inside the box, nodes apart", () => {
    const k4: NodeGraph = { title: "", nodes: ["1", "2", "3", "4"].map((id) => ({ id, label: id })), edges: [["1", "2"], ["2", "3"], ["3", "4"], ["4", "1"], ["1", "3"], ["2", "4"]].map(([from, to]) => ({ from, to })) };
    const a = springs(k4, 600, 400);
    assert.deepEqual(a, springs(k4, 600, 400));
    const ps = Object.values(a);
    for (const q of ps) assert.ok(q.x >= 0 && q.x <= 600 && q.y >= 0 && q.y <= 400);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert.ok(Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y) > 40);
  });

  test("labels wrap to two lines at most", () => {
    assert.deepEqual(wrap("short"), ["short"]);
    assert.deepEqual(wrap("eigen vector space"), ["eigen vector", "space"]);
    const w = wrap("a very long label that goes on and on and on");
    assert.equal(w.length, 2);
    assert.ok(w[1].endsWith("…"));
  });
});
