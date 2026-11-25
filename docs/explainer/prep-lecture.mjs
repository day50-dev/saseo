// The lecture branch of the bialgebra canvas: Maltoni's IAS lecture, stopped where the board defines
// U_q(g), the definition boxed, and its card explained (answering the card's question if it asks one).
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
const box = JSON.parse(readFileSync(`${DIR}box1.json`, "utf8"));
const api = await request.newContext({ baseURL: "https://librarian.9ol.es", storageState: `${DIR}state.json`, timeout: 180000 });
const j = async (r) => { if (!r.ok()) throw new Error(`${r.status()} ${await r.text()}`); return r.json(); };
const C = `/api/canvases/${ids.bialgebra}`;
const item = async (id) => (await j(await api.get(C))).items.find((x) => x.id === id);
const X = 1900;
const { image: video } = await j(await api.post(`${C}/sources`, { data: { input: "https://www.youtube.com/watch?v=Z8rgWuyjxKE", x: X, y: 0 } }));
const { image: frame } = await j(await api.post(`${C}/videos/${video.id}/moments`, { data: { t: 900, x: X, y: 480 } }));
console.log("frame", frame.id, frame.w, frame.h);
const { card } = await j(await api.post(`${C}/regions`, { data: { imageId: frame.id, rect: box.rect, card: { x: X + frame.w + 80, y: 480 }, marked: box.marked, crop: box.crop } }));
let c;
for (let i = 0; i < 200; i++) {
  c = await item(card.id);
  if (c.stage === "asking" && c.clarify && !c.clarify.answer) {
    console.log("asks:", c.clarify.question, JSON.stringify(c.clarify.options ?? []));
    await j(await api.post(`${C}/cards/${card.id}/answer`, { data: { answer: "I know linear algebra. I'm watching a lecture on quantum groups and got lost at this definition." } }));
  }
  if (c.stage === "done" || c.stage === "failed") break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("card", c.stage, c.subject, c.error ?? "");
console.log(JSON.stringify(c.sem, null, 1));
writeFileSync(`${DIR}canvases.json`, JSON.stringify({ ...ids, lectureVideo: video.id, lectureFrame: frame.id, lectureCard: card.id }, null, 2));
await api.dispose();
