// The model's judgment, with the real configured model (data/config.json): the other suites check
// what Librarian does with an answer; these check that a real model gives good ones. Slow, and they
// cost model calls, so they run only with `npm run test:live`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { until } from "../helpers/env.ts";
import { explained, objectCard, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, CardItem } from "../../shared/canvas.ts";

const CONFIG = path.resolve(import.meta.dirname, "../../data/config.json");
const skip = !existsSync(CONFIG) && "no data/config.json: set up a model under Settings first";
let s: TestServer;

before(async () => {
  if (skip) return;
  const dir = mkdtempSync(path.join(tmpdir(), "librarian-live-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "data");
  seed(data, [
    {
      id: "live0001",
      name: "Live",
      items: [
        explained("eig", "Eigenvectors", 0, 0, { h: 500 }),
        objectCard("g1", { type: "graph", title: "K4", nodes: [{ id: "a", label: "A" }], edges: [] }, 800, 0, { h: 400 }),
        objectCard("g2", { type: "graph", title: "The Petersen graph", nodes: [{ id: "a", label: "A" }], edges: [] }, 800, 500, { h: 400 }),
        objectCard("p1", { type: "plot", title: "y = x²", plot: { x: {}, y: {}, series: [{ fn: "x^2" }] } }, 1600, 0, { h: 400 }),
        objectCard("t1", { type: "table", title: "Populations", columns: ["city", "people"], rows: [["Paris", 2]], sources: [] }, 1600, 500, { h: 400 }),
      ],
    },
  ]);
  s = await startServer({ LIBRARIAN_DATA: data, SEMSHAPES_CONFIG: CONFIG });
});
after(async () => s?.stop());

const items = async () => ((await s.api("GET", "/api/canvases/live0001")).body as CanvasState).items.filter((i): i is CardItem => i.kind === "card");

describe("live: what a message on a card asks for", { skip, timeout: 600_000 }, () => {
  const cases: [string, string][] = [
    ["Can you plot y = x^3 - 3x?", "plot"],
    ["Draw the complete graph K5", "graph"],
    ["Map the places Lagrange lived, in order", "map"],
    ["What were the populations of the largest European cities in 1800?", "table"],
    ["Why does this matter?", "answer"],
  ];
  for (const [text, kind] of cases) {
    test(`"${text}" → ${kind}`, async () => {
      const before = (await items()).length;
      await s.api("POST", "/api/canvases/live0001/cards/eig/chat", { text });
      const card = await until(async () => {
        const c = (await items()).find((x) => x.id === "eig")!;
        return c.chatPending === false && c.chat?.at(-1)?.role === "assistant" ? c : null;
      }, 180_000, "the reply");
      const last = card.chat!.at(-1)!;
      if (kind === "answer") assert.equal(last.objectId, undefined, last.text);
      else {
        const made = (await items()).find((x) => x.id === last.objectId);
        assert.equal(made?.objectKind, kind, last.text);
        assert.equal((await items()).length, before + 1);
      }
    });
  }
});

describe("live: a call", { skip, timeout: 600_000 }, () => {
  const call = (text: string, pointing = {}, context = {}) => s.api("POST", "/api/canvases/live0001/call", { text, pointing, context }).then((r) => r.body);

  test("pointing at a piece and asking: a short, direct answer with no look-ups", async () => {
    const r = await call("what is this?", { cardId: "eig", key: "what-0", pieceText: "Eigenvectors in one line" });
    assert.ok(r.say && r.say.length < 600, r.say);
    assert.equal(r.looked, undefined, `looked up ${r.looked}`);
  });

  for (const words of ["get rid of the graph", "take the chart off"]) {
    test(`"${words}" with two that fit: it numbers them and asks, removing nothing`, async () => {
      const r = await call(words);
      assert.equal(r.removed, undefined, `removed ${r.removed}: ${r.say}`);
      assert.ok((r.marks?.length ?? 0) >= 2, `no marks: ${r.say}`);
    });
  }

  test("a pick removes the one picked", async () => {
    const asked = await call("get rid of the graph");
    const petersen = asked.marks?.find((m: { cardId: string }) => m.cardId === "g2");
    assert.ok(petersen, JSON.stringify(asked));
    const r = await call(String(petersen.n), {}, { picked: petersen.n, marks: asked.marks });
    assert.deepEqual(r.removed, ["g2"], r.say);
    await s.api("POST", "/api/canvases/live0001/show", { ids: ["g2"] });
  });
});
