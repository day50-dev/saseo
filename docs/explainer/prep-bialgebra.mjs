// The demo canvas for the bialgebra video: Wikipedia's Bialgebra article, read and drawn as shapes.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const SITE = "https://librarian.9ol.es";
const api = await request.newContext({ baseURL: SITE, storageState: `${DIR}state.json` });
const j = async (r) => { if (!r.ok()) throw new Error(`${r.status()} ${await r.text()}`); return r.json(); };
const canvas = await j(await api.post("/api/canvases", { data: { name: "Bialgebra" } }));
const { card } = await j(await api.post(`/api/canvases/${canvas.id}/sources`, { data: { input: "https://en.wikipedia.org/wiki/Bialgebra", x: 0, y: 0 } }));
const state = async () => (await j(await api.get(`/api/canvases/${canvas.id}`))).items;
let c;
for (let i = 0; i < 300; i++) {
  c = (await state()).find((x) => x.id === card.id);
  if (i % 10 === 0) console.log(c.stage, c.shaping, c.sections?.filter((s) => s.status === "done").length, "/", c.sections?.length);
  if (c.stage === "failed" || (c.stage === "done" && c.shaping === "done" && c.sections?.length && c.sections.every((s) => s.status !== "working"))) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("done:", c.stage, c.shaping, c.error ?? "");
const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
writeFileSync(`${DIR}canvases.json`, JSON.stringify({ ...ids, bialgebra: canvas.id, bialgebraCard: card.id }, null, 2));
await api.dispose();
