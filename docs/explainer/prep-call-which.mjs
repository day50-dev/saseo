// The new call scene's turns, made for real, then replayed while recording.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
const api = await request.newContext({ baseURL: "https://librarian.9ol.es", storageState: `${DIR}state.json` });
const s = await (await api.get(`/api/canvases/${ids.lagrange}`)).json();
const map = s.items.find((x) => x.id === ids.map).object;
const i = map.places.findIndex((p) => /berlin/i.test(p.name));
const figure = `place ${i + 1} of ${map.places.length} on the map: ${map.places[i].name}${map.places[i].note ? ` (${map.places[i].note})` : ""}`;
const call = async (data) => {
  const t = Date.now();
  const r = await (await api.post(`/api/canvases/${ids.lagrange}/call`, { data })).json();
  console.log((Date.now() - t) / 1000, "s", JSON.stringify(r));
  return r;
};
const t1 = "why did he move here?";
const r1 = await call({ text: t1, history: [], pointing: { cardId: ids.map, figure }, context: { timeline: [{ at: 0, p: { cardId: ids.map, figure } }], spoke: 1600 } });
const history = [{ role: "you", text: t1 }, { role: "librarian", text: r1.say }];
const t2 = "and take the chart off";
const visible = [ids.plot, ids.graph, ids.table, ids.map];
const r2 = await call({ text: t2, history, pointing: {}, context: { visible } });
if (r2.removed?.length) await api.post(`/api/canvases/${ids.lagrange}/show`, { data: { ids: r2.removed } });
const out = { figure, berlin: i, turns: [{ text: t1, ...r1 }, { text: t2, ...r2 }] };
if (r2.marks?.length) {
  const pick = r2.marks.find((m) => m.cardId === ids.table) ?? r2.marks[0];
  const r3 = await call({ text: `Number ${pick.n}`, history: [...history, { role: "you", text: t2 }, { role: "librarian", text: r2.say }], pointing: { cardId: pick.cardId }, context: { picked: pick.n, marks: r2.marks } });
  out.turns.push({ text: `Number ${pick.n}`, pick: pick.n, ...r3 });
  if (r3.removed?.length) await api.post(`/api/canvases/${ids.lagrange}/show`, { data: { ids: r3.removed } });
}
writeFileSync(`${DIR}call2.json`, JSON.stringify(out, null, 2));
await api.dispose();
