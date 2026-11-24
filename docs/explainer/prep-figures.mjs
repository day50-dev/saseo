// The demo canvas for the figures, asks and goals scenes: the Wikipedia article on Lagrangian
// mechanics, with lectures, a plot, a graph, a table and a map asked for in its chat.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const SITE = "https://librarian.9ol.es";
const api = await request.newContext({ baseURL: SITE, storageState: `${DIR}state.json` });
const j = async (r) => { if (!r.ok()) throw new Error(`${r.status()} ${await r.text()}`); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const me = await j(await api.get("/api/me"));
console.log("as", me.user?.id, me.user?.anonymous);
const canvas = await j(await api.post("/api/canvases", { data: { name: "Lagrangian mechanics" } }));
const { card } = await j(await api.post(`/api/canvases/${canvas.id}/sources`, { data: { input: "https://en.wikipedia.org/wiki/Lagrangian_mechanics", x: 0, y: 0 } }));
const state = async () => j(await api.get(`/api/canvases/${canvas.id}`));
for (let i = 0; i < 120; i++) {
  const c = (await state()).items.find((x) => x.id === card.id);
  if (c.stage === "done" && c.shaping !== "working") break;
  await sleep(2000);
}
console.log("page read");
const asks = [
  ["videos", "find me university lectures on this, from actual physics courses"],
  ["plot", "plot the swing of a simple pendulum over time, small-angle solution"],
  ["graph", "draw a graph of how the main ideas connect, from generalized coordinates to Hamilton's equations"],
  ["table", "a table of the planets' distance from the sun and orbital period"],
  ["map", "map the places in Lagrange's life, in order"],
];
const ids = { lagrange: canvas.id, lagrangeCard: card.id };
for (const [kind, text] of asks) {
  for (let i = 0; i < 60; i++) {
    const c = (await state()).items.find((x) => x.id === card.id);
    if (!c.chatPending) break;
    await sleep(1000);
  }
  await j(await api.post(`/api/canvases/${canvas.id}/cards/${card.id}/chat`, { data: { text } }));
  let o;
  for (let i = 0; i < 120; i++) {
    o = (await state()).items.find((x) => x.objectKind === kind);
    if (o && (o.stage === "done" || o.stage === "failed")) break;
    await sleep(2000);
  }
  console.log(kind, o?.stage, o?.subject, o?.error ?? "");
  ids[kind] = o?.id;
}
await sleep(8000);
const s = await state();
console.log("goals", JSON.stringify((s.goals ?? []).map((g) => [g.kind, g.text, g.cards.length])));
const all = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
writeFileSync(`${DIR}canvases.json`, JSON.stringify({ ...all, ...ids }, null, 2));
await api.dispose();
