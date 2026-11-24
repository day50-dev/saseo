// Adds a descent on "generalized coordinates" to the Lagrangian canvas (so the goals scene has a
// subgoal), placed in a column of its own beside the figures.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
const api = await request.newContext({ baseURL: "https://librarian.9ol.es", storageState: `${DIR}state.json` });
const state = async () => (await api.get(`/api/canvases/${ids.lagrange}`)).json();
const s0 = await state();
const page = s0.items.find((x) => x.id === ids.lagrangeCard);
const vid = s0.items.find((x) => x.id === ids.videos);
const { card } = await (await api.post(`/api/canvases/${ids.lagrange}/descend`, { data: { parentId: page.id, selection: "generalized coordinates", x: vid.x + vid.w + 64, y: page.y } })).json();
for (let i = 0; i < 120; i++) {
  const s = await state();
  const c = s.items.find((x) => x.id === card.id);
  if (c.stage === "asking") {
    const o = c.clarify?.options ?? [];
    const pick = o.find((x) => /curious|new|first|intuition|big picture/i.test(x)) ?? o[0] ?? "";
    console.log("answering", c.clarify?.question, "->", pick);
    await api.post(`/api/canvases/${ids.lagrange}/cards/${card.id}/answer`, { data: { answer: pick } });
  }
  if (c.stage === "done" || c.stage === "failed") { console.log(c.stage, c.subject); break; }
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 8000));
const s = await state();
console.log("goals", JSON.stringify((s.goals ?? []).map((g) => [g.kind, g.text, g.parentId ?? "", g.cards.length])));
writeFileSync(`${DIR}canvases.json`, JSON.stringify({ ...ids, coords: card.id }, null, 2));
await api.dispose();
