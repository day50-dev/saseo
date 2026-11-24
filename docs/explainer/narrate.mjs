// Narrates scenes (SCRIPT=…/script.json when run from a work folder) through the site's own speech route (Kokoro, af_heart), as the demo visitor.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const script = JSON.parse(readFileSync(process.env.SCRIPT ?? new URL("script.json", import.meta.url).pathname, "utf8"));
const api = await request.newContext({ baseURL: "https://librarian.9ol.es", storageState: `${DIR}state.json` });
for (const id of process.argv.slice(2)) {
  const s = script.scenes.find((x) => x.id === id);
  const r = await api.post("/api/speech/say", { data: { text: s.say }, timeout: 120000 });
  if (!r.ok()) throw new Error(`${id}: ${r.status()} ${await r.text()}`);
  writeFileSync(`${DIR}audio/${id}.wav`, await r.body());
  console.log(id);
}
await api.dispose();
