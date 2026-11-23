// The demo canvas for the new scenes: the Eigenvalues article, and an example notebook asked for on it.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const SITE = "https://librarian.9ol.es";
const api = await request.newContext({ baseURL: SITE, storageState: `${DIR}state.json` });
const j = async (r) => { if (!r.ok()) throw new Error(`${r.status()} ${await r.text()}`); return r.json(); };
const me = await j(await api.get("/api/me"));
console.log("as", me.user?.id, me.user?.anonymous);
const canvas = await j(await api.post("/api/canvases", { data: { name: "Eigenvalues and eigenvectors" } }));
const { card } = await j(await api.post(`/api/canvases/${canvas.id}/sources`, { data: { input: "https://en.wikipedia.org/wiki/Eigenvalues_and_eigenvectors", x: 0, y: 0 } }));
const state = async () => (await j(await api.get(`/api/canvases/${canvas.id}`))).items;
for (let i = 0; i < 30; i++) {
  const c = (await state()).find((x) => x.id === card.id);
  console.log(c.stage, c.shaping, c.sections?.filter((s) => s.status === "done").length, "/", c.sections?.length);
  if (c.stage === "done" && c.shaping === "done") break;
  await new Promise((r) => setTimeout(r, 1000));
}
await j(await api.post(`/api/canvases/${canvas.id}/cards/${card.id}/chat`, { data: { text: "can you give me an example of eigenvectors in a jupyter notebook?" } }));
let nb;
for (let i = 0; i < 90; i++) {
  nb = (await state()).find((x) => x.objectKind === "notebook");
  if (nb && (nb.stage === "done" || nb.stage === "failed")) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("notebook", nb?.stage, nb?.object?.title, nb?.object?.language, nb?.object?.source, nb?.object?.cells?.length, nb?.error);
const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
writeFileSync(`${DIR}canvases.json`, JSON.stringify({ ...ids, page: canvas.id, pageCard: card.id, notebook: nb?.id }, null, 2));
await api.dispose();
