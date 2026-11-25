import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const api = await request.newContext({ baseURL: "https://librarian.9ol.es", storageState: `${DIR}state.json`, timeout: 120000 });
const C = "/api/canvases/8a401089";
const moves = [
  { id: "9f62e0f3", x: 0, y: 0, h: 146 },
  { id: "930a2f51", x: 800, y: 0, h: 1891 },
  { id: "905000bc", x: 1923, y: 0, h: 965 },
  { id: "76f04a48", x: 1923, y: 1045, h: 1110 },
  { id: "5063ccdb", x: 2963, y: 0, h: 1402 },
  { id: "77e3bf7f", x: 2963, y: 1482, h: 620 },
  { id: "a06e02f6", x: 4003, y: 0, h: 3546 },
  { id: "b8d73185", x: 1923, y: 2600, h: 1343 },
];
console.log("move", (await api.post(`${C}/move`, { data: { moves } })).status(), await (await api.post(`${C}/move`, { data: { moves } })).text());
// A note of your own on the diagram: what the arrows mean.
const note = await (await api.post(`${C}/notes`, { data: { text: "Clockwise: above the axis p > 0, so q is increasing.", x: 2675, y: 1045, on: { id: "76f04a48" } } })).json();
console.log("note", note.note?.id);
// A lecture from the set, on the canvas, under the chapter's videos.
const v = await (await api.post(`${C}/sources`, { data: { input: "https://www.youtube.com/watch?v=mYDrufxpW9E", x: 2963, y: 2182 } })).json();
console.log("video", v.image?.id, v.image?.name, v.image?.w, v.image?.h, v.error ?? "");
const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
Object.assign(ids, { ham: "8a401089", hamQ: "9f62e0f3", hamCard: "930a2f51", hamSet: "905000bc", hamDiagram: "76f04a48", hamChapter: "5063ccdb", hamVideos: "77e3bf7f", hamWiki: "a06e02f6", hamRelation: "b8d73185", hamNote: note.note?.id, hamVideo: v.image?.id });
writeFileSync(`${DIR}canvases.json`, JSON.stringify(ids, null, 2));
await api.dispose();
