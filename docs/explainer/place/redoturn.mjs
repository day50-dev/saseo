import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const api = await request.newContext({ baseURL: "https://librarian.9ol.es", storageState: `${DIR}state.json`, timeout: 600000 });
const C = "/api/canvases/8a401089";
const items = async () => (await (await api.get(C)).json()).items;
// The stray notebook, and the old set.
const OLD = process.argv[2];
const stray = (await items()).filter((i) => i.parentId === OLD && !i.hidden).map((i) => i.id);
const gone = await (await api.post(`${C}/hide`, { data: { ids: [...stray, OLD] } })).json();
console.log("hidden", gone.ids);
const call = JSON.parse(readFileSync(`${DIR}call4.json`, "utf8"));
const N = Number(process.argv[3] ?? 1);
const t = call.turns[N];
const history = call.turns.slice(0, N).flatMap((x) => [{ role: "you", text: x.text }, { role: "librarian", text: x.reply.say }]);
const before = new Set((await items()).map((i) => i.id));
const r = await (await api.post(`${C}/call`, { data: { text: t.text, pointing: t.pointing, history } })).json();
console.log("LIBRARIAN:", r.say, "| did:", r.did);
let made = [];
for (let i = 0; i < 100; i++) {
  made = (await items()).filter((x) => !before.has(x.id));
  if (made.length && made.every((m) => m.stage === "done" || m.stage === "failed")) break;
  await new Promise((r) => setTimeout(r, 3000));
}
for (const m of made) {
  console.log("made", m.id, m.objectKind, m.stage, m.subject, m.x, m.y);
  for (const e of m.object?.entries ?? []) console.log("  -", e.title, "|", e.image ? e.image.slice(0, 90) : "NOIMG", e.unverified ? "UNVERIFIED" : "");
}
call.turns[N] = { ...t, reply: r, grown: [], made: made.map((m) => ({ id: m.id, kind: m.objectKind ?? "card", stage: m.stage, subject: m.subject })) };
writeFileSync(`${DIR}call4.json`, JSON.stringify(call, null, 2));
await api.dispose();
