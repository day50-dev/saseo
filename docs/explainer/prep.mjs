// Builds the demo canvases on the live site, as a fresh anonymous visitor, for the explainer's footage.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const DIR = new URL(".", import.meta.url).pathname;
const SITE = "https://librarian.9ol.es";
const SLIDE = process.env.SLIDE ?? "slide.png";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ctx = await chromium.launchPersistentContext(`${DIR}profile`, {
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  viewport: { width: 1920, height: 1080 },
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(30_000);

await page.goto(SITE);
await page.waitForTimeout(3000);
const api = (path, body) =>
  page.evaluate(
    async ([path, body]) => {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return r.json();
    },
    [path, body],
  );
const state = (cid) => page.evaluate(async (cid) => (await fetch(`/api/canvases/${cid}`)).json(), cid);

/** Waits until every card is finished, answering the librarian's question if it asks one. */
async function settle(cid, label, max = 300) {
  for (let i = 0; i < max; i++) {
    const s = await state(cid);
    const cards = s.items.filter((x) => x.kind === "card" && !x.hidden);
    const asking = cards.find((c) => c.stage === "asking");
    if (asking) {
      const options = asking.clarify?.options ?? [];
      const pick = options.find((o) => /curious|new|first|intuition|big picture/i.test(o)) ?? options[0] ?? "";
      log(label, "answering:", asking.clarify?.question, "->", pick);
      await api(`/api/canvases/${cid}/cards/${asking.id}/answer`, { answer: pick });
    }
    const busy = cards.some(
      (c) => !["done", "failed", "asking"].includes(c.stage) || c.looking === "working" || c.ext?.some((e) => e.status === "working") || (c.sem && !c.taught && !c.relates),
    );
    if (!busy && !asking) return s;
    await page.waitForTimeout(2000);
  }
  throw new Error(`${label}: still busy`);
}

// ---- The talk ----
const talk = await api("/api/canvases", { name: "A research talk" });
log("talk canvas", talk.id);
const png = readFileSync(SLIDE).toString("base64");
await page.goto(`${SITE}/c/${talk.id}`);
await page.waitForTimeout(2000);
await page.evaluate(
  async ([cid, png]) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([bytes], "slide-19.png", { type: "image/png" }));
    for (const [k, v] of Object.entries({ x: 120, y: 140, w: 901, h: 680, naturalW: 901, naturalH: 680 })) form.append(k, String(v));
    await fetch(`/api/canvases/${cid}/images`, { method: "POST", body: form });
  },
  [talk.id, png],
);
await page.reload();
await page.waitForTimeout(3000);
// Reset the view so the slide sits where we expect it.
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()))?.click());
await page.waitForTimeout(800);
const img = await page.locator("img.source-image").first().boundingBox();
log("slide at", img);
// "Biot-Savart law," on the first line of the slide.
const k = img.width / 901;
await page.mouse.move(img.x + 318 * k, img.y + 94 * k);
await page.mouse.down();
await page.mouse.move(img.x + 470 * k, img.y + 126 * k, { steps: 12 });
await page.mouse.up();
log("boxed Biot-Savart law");
for (let i = 0; i < 60 && !(await state(talk.id)).items.some((x) => x.kind === "card"); i++) await page.waitForTimeout(1000);
let s = await settle(talk.id, "talk box");
const first = s.items.find((x) => x.kind === "card" && x.sem);
log("first card", first?.subject, first?.stage);

// Descend from a stand-in or term in its explanation.
await page.reload();
await page.waitForTimeout(3000);
const phrase = await page.evaluate(() => {
  const t = document.querySelector(".card-item .sem-standin, .card-item .sem-term");
  if (!t) return null;
  t.scrollIntoView({ block: "center" });
  return t.dataset.explain ?? t.textContent;
});
log("descending on", phrase);
if (phrase) {
  await page.locator(".card-item .sem-standin, .card-item .sem-term").first().click();
  await page.waitForTimeout(400);
  await page.locator(".descend").first().click();
  s = await settle(talk.id, "talk descend");
}

// Grow a "why" from the first card's second why step.
await api(`/api/canvases/${talk.id}/cards/${first.id}/extend`, { at: "why-1", shape: "why" });
s = await settle(talk.id, "talk grow");
log("talk ready", s.items.filter((x) => x.kind === "card").map((c) => `${c.subject}:${c.stage}`));

// ---- The lecture ----
const lec = await api("/api/canvases", { name: "A lecture" });
log("lecture canvas", lec.id);
await page.goto(`${SITE}/c/${lec.id}`);
await page.waitForTimeout(2000);
await api(`/api/canvases/${lec.id}/sources`, { input: "https://www.youtube.com/watch?v=PFDu9oVAE-g", x: 80, y: 140 });
await page.reload();
await page.waitForTimeout(6000);
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()))?.click());
const frame = page.frameLocator(".video-frame iframe");
// Seek with the player's own message protocol, then stop there.
await page.evaluate(() => {
  const w = document.querySelector(".video-frame iframe").contentWindow;
  const send = (func, args = []) => w.postMessage(JSON.stringify({ event: "command", func, args }), "*");
  send("seekTo", [150, true]);
  send("pauseVideo");
});
await page.waitForTimeout(2500);
await page.locator(".video-stop").click();
for (let i = 0; i < 60 && (await page.locator("img.source-image").count()) === 0; i++) await page.waitForTimeout(1000);
await page.waitForTimeout(1500);
const fr = await page.locator("img.source-image").first().boundingBox();
log("moment frame at", fr);
// Box the middle of the frame, where the vectors are.
await page.mouse.move(fr.x + fr.width * 0.3, fr.y + fr.height * 0.2);
await page.mouse.down();
await page.mouse.move(fr.x + fr.width * 0.75, fr.y + fr.height * 0.8, { steps: 12 });
await page.mouse.up();
for (let i = 0; i < 60 && !(await state(lec.id)).items.some((x) => x.kind === "card" && x.parentId && x.selection === undefined && x.stage); i++) await page.waitForTimeout(1000);
await page.waitForTimeout(3000);
s = await settle(lec.id, "lecture box");
log("lecture ready", s.items.filter((x) => x.kind === "card").map((c) => `${c.subject}:${c.stage}`));

const before = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
writeFileSync(`${DIR}canvases.json`, JSON.stringify({ ...before, talk: talk.id, lecture: lec.id }, null, 2));
void frame;
await ctx.close();
log("done");
