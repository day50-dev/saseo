// The bialgebra canvas's branch: a piece grown in place, then things from elsewhere hung from the card
// (a lecture, a graph, a runnable example, papers), as a reader would ask for them.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
const api = await request.newContext({ baseURL: "https://librarian.9ol.es", storageState: `${DIR}state.json` });
const j = async (r) => { if (!r.ok()) throw new Error(`${r.status()} ${await r.text()}`); return r.json(); };
const C = `/api/canvases/${ids.bialgebra}`;
const items = async () => (await j(await api.get(C))).items;
const card = async (id) => (await items()).find((x) => x.id === id);
const wait = async (what, ok, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    const v = await ok();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("timed out:", what);
};
const id = ids.bialgebraCard;
// A worked example grown from the comultiplication piece, in place.
const { ext } = await j(await api.post(`${C}/cards/${id}/extend`, { data: { at: "part-3", shape: "example" } }));
await wait("example", async () => (await card(id)).ext?.find((e) => e.id === ext.id && e.status !== "working"));
console.log("example:", JSON.stringify((await card(id)).ext.find((e) => e.id === ext.id).items));
const made = {};
for (const [key, text] of [
  ["videos", "Can you find a lecture video on bialgebras and Hopf algebras?"],
  ["graph", "Draw a graph of how bialgebras relate to algebras, coalgebras, Hopf algebras, Lie bialgebras and Frobenius algebras"],
  ["notebook", "Can you give me a runnable example of the group bialgebra in a Jupyter notebook?"],
  ["papers", "Find research papers on bialgebras"],
]) {
  const before = (await card(id)).chat?.length ?? 0;
  await j(await api.post(`${C}/cards/${id}/chat`, { data: { text } }));
  const reply = await wait(key, async () => {
    const c = await card(id);
    return !c.chatPending && (c.chat?.length ?? 0) > before + 1 ? c.chat.at(-1) : null;
  });
  const obj = reply?.objectId && (await wait(`${key} card`, async () => {
    const o = await card(reply.objectId);
    return o && (o.stage === "done" || o.stage === "failed") ? o : null;
  }, 200));
  made[key] = obj?.id;
  console.log(key, obj?.objectKind, obj?.stage, obj?.subject, obj?.error ?? "");
}
writeFileSync(`${DIR}canvases.json`, JSON.stringify({ ...ids, bialgebraExample: ext.id, bialgebraMade: made }, null, 2));
await api.dispose();
