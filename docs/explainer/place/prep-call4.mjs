// A real call on the lecture card: questions asked while pointing at its pieces. Each answer, and
// whatever it grew or opened, is saved (call4.json) so the recording can replay the call as it was.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const api = await request.newContext({ baseURL: "https://librarian.9ol.es", storageState: `${DIR}state.json`, timeout: 240000 });
const C = `/api/canvases/${"8a401089"}`;
const items = async () => (await (await api.get(C)).json()).items;
const card = (await items()).find((x) => x.id === "930a2f51");
const piece = (key) => {
  const s = card.sem;
  const [k, i] = key.split("-");
  const t = k === "part" ? `${s.parts[+i].symbol}: ${s.parts[+i].meaning}` : k === "what" ? (+i === 0 ? s.what.gist : s.what.details[+i - 1]) : s[k][+i];
  return { cardId: card.id, key, pieceText: t };
};
const turns = [
  { text: "Can you expand on this?", pointing: piece("here-3") },
  { text: "Give me some examples of Hamiltonian systems.", pointing: piece("what-0") },
  { text: "Can you draw me a diagram of phase space?", pointing: piece("here-4") },
];
const history = [];
const out = [];
for (const t of turns) {
  const before = new Map((await items()).map((i) => [i.id, JSON.stringify(i.ext?.map((e) => e.id) ?? [])]));
  const r = await (await api.post(`${C}/call`, { data: { text: t.text, pointing: t.pointing, history } })).json();
  console.log("\nYOU:", t.text, `(pointing at ${t.pointing.key})`, "\nLIBRARIAN:", r.say, "\n  did:", r.did ?? "-", r.looked ? `looked: ${r.looked}` : "");
  history.push({ role: "you", text: t.text }, { role: "librarian", text: r.say });
  // Wait for what it started: shapes grown on cards, new cards made.
  let grown = [], made = [];
  for (let i = 0; i < 120; i++) {
    const now = await items();
    grown = now.flatMap((x) => (x.ext ?? []).filter((e) => !JSON.parse(before.get(x.id) ?? "[]").includes(e.id)).map((e) => ({ card: x.id, ext: e.id, status: e.status, shape: e.shape, items: e.items })));
    made = now.filter((x) => !before.has(x.id)).map((x) => ({ id: x.id, kind: x.objectKind ?? "card", stage: x.stage, subject: x.subject }));
    if ([...grown, ...made].every((g) => g.status !== "working" && g.stage !== "reading" && g.stage !== "searching" && g.stage !== "writing" && g.stage !== "checking")) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("  grown:", JSON.stringify(grown), "\n  made:", JSON.stringify(made));
  out.push({ ...t, reply: r, grown, made });
}
writeFileSync(`${DIR}call4.json`, JSON.stringify({ turns: out }, null, 2));
await api.dispose();
