// Records the explainer's app footage, one clip per scene, from the demo canvases prep.mjs built.
// Usage: node record.mjs [scene ...]   (default: all app scenes)
import { mkdirSync, readFileSync, renameSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const DIR = process.env.WORK ?? new URL(".", import.meta.url).pathname; // where profiles, clips and shots go
const SITE = "https://librarian.9ol.es";
const { talk, lecture } = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
const W = 1920;
const H = 1080;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
mkdirSync(`${DIR}clips`, { recursive: true });

// Recorded in plain contexts carrying the demo visitor's session (saved from the profile prep used).
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const newScene = () =>
  browser.newContext({
    storageState: `${DIR}state.json`,
    viewport: { width: W, height: H },
    recordVideo: { dir: `${DIR}raw`, size: { width: W, height: H } },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// When each shot really starts, in seconds into its clip (after the page has loaded and been framed).
let t0 = 0;
let current = "";
const marks = {};
const start = () => {
  marks[current] = (Date.now() - t0) / 1000;
};

/** Opens a canvas at 100% and waits for it to settle. */
async function open(page, cid) {
  await page.goto(`${SITE}/c/${cid}`);
  await page.waitForSelector(".stage");
  await sleep(2500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()));
    if (b && b.textContent.trim() !== "100%") b.click();
    document.querySelector(".start-open")?.remove(); // keep the shot clean
  });
  await sleep(500);
  // Closer than 100%, so card text reads at video size.
  for (let i = 0; i < 12; i++) {
    const z = await page.evaluate(() => Number([...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()))?.textContent.trim().replace("%", "")));
    if (z >= ZOOM) break;
    await page.mouse.move(W / 2, H / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -40);
    await page.keyboard.up("Control");
    await sleep(120);
  }
  await page.evaluate(() => document.querySelector(".start-open")?.remove());
}
const ZOOM = Number(process.env.ZOOM ?? 140);

/** Glides the view so that a screen point (x, y) moves to (tx, ty), over `ms`. */
async function glide(page, from, to, ms) {
  const steps = Math.max(10, Math.round(ms / 16));
  const dx = (from.x - to.x) / steps;
  const dy = (from.y - to.y) / steps;
  // A corner, away from any video player (which would swallow the scroll).
  await page.mouse.move(W - 30, H - 30);
  for (let i = 0; i < steps; i++) {
    // Ease in and out.
    const t = (i + 0.5) / steps;
    const k = 6 * t * (1 - t) * 1.0;
    // Straight to the canvas, so nothing under the cursor (a video player) can swallow it.
    await page.evaluate(
      ([x, y]) =>
        document.querySelector(".stage").dispatchEvent(new WheelEvent("wheel", { deltaX: x, deltaY: y, bubbles: true, cancelable: true, clientX: 960, clientY: 540 })),
      [dx * k, dy * k],
    );
    await sleep(ms / steps);
  }
}

/** Zooms around a screen point by `ticks` ctrl+wheel steps (negative zooms in). */
async function zoom(page, at, ticks, ms) {
  await page.mouse.move(at.x, at.y);
  const n = Math.abs(ticks);
  for (let i = 0; i < n; i++) {
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, Math.sign(ticks) * 40);
    await page.keyboard.up("Control");
    await sleep(ms / n);
  }
}

const box = (page, sel) => page.locator(sel).first().boundingBox();

/** Brings an element's top-left to a screen point, gliding. */
async function bring(page, sel, tx, ty, ms = 1500) {
  const b = await box(page, sel);
  if (!b) throw new Error(`not found: ${sel}`);
  await glide(page, { x: b.x, y: b.y }, { x: tx, y: ty }, ms);
}

/** Smoothly moves the mouse to an element's centre (a visible cursor isn't drawn; hover effects are). */
async function hover(page, sel, ms = 600) {
  const b = await box(page, sel);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: Math.round(ms / 16) });
}

const card = (subject) => `.card-item:has(.asked-text:text-is("${subject}"))`;

const scenes = {
  // A box drawn over a phrase on the slide; the placeholder appears where the card will land.
  async "03-idea"(page) {
    await open(page, talk);
    await bring(page, "img.source-image", 140, 200, 10);
    await sleep(600);
    start();
    await sleep(900);
    const img = await box(page, "img.source-image");
    const k = img.width / 901;
    // "vorticity" in "where the vorticity is".
    await page.mouse.move(img.x + 146 * k, img.y + 414 * k, { steps: 20 });
    await sleep(400);
    await page.mouse.down();
    await page.mouse.move(img.x + 246 * k, img.y + 456 * k, { steps: 40 });
    // Held, not released: sending the box locks up a headless page while it's screen-recorded.
    await sleep(8000);
  },

  // The explanation, read down section by section.
  async "04-descend"(page) {
    await open(page, talk);
    const first = ".card-item:has(.sem)";
    await bring(page, first, 560, 60, 10);
    await sleep(600);
    start();
    await sleep(900);
    for (const sel of [".facet-why", ".facet-what", ".facet-parts", ".facet-here"]) {
      const b = await page.locator(`${first} ${sel}`).first().boundingBox();
      if (!b) continue;
      await glide(page, { x: b.x, y: b.y }, { x: b.x, y: 140 }, 1800);
      await sleep(1300);
    }
  },

  // Strict terms and stand-ins, close up.
  async "05-register"(page) {
    await open(page, talk);
    const first = ".card-item:has(.sem)";
    const s = await box(page, `${first} .sem-standin`);
    await glide(page, { x: s.x, y: s.y }, { x: 700, y: 480 }, 10);
    await sleep(600);
    start();
    await sleep(200);
    await zoom(page, { x: 700, y: 480 }, -4, 1600);
    await sleep(1500);
    await hover(page, `${first} .sem-standin`, 800);
    await sleep(2500);
    await hover(page, `${first} .sem-term`, 800);
    await sleep(3500);
  },

  // Selecting words offers to go further down; the card that went down sits beside it.
  async "06-deeper"(page) {
    await open(page, talk);
    const first = ".card-item:has(.sem)";
    const t = await box(page, `${first} .sem-what .sem-desc, ${first} .sem-desc`);
    await glide(page, { x: t.x, y: t.y }, { x: 420, y: 380 }, 10);
    await sleep(600);
    start();
    await sleep(400);
    const term = page.locator(`${first} .sem-body .sem-standin, ${first} .sem-body .sem-term`).first();
    const tb = await term.boundingBox();
    await glide(page, { x: tb.x, y: tb.y }, { x: 520, y: 420 }, 1200);
    await sleep(600);
    await term.click();
    await sleep(2500);
    // The descent already made, beside it.
    const cards = await page.locator(".card-item:has(.sem)").all();
    if (cards.length > 1) {
      const b = await cards[1].boundingBox();
      await glide(page, { x: b.x, y: b.y }, { x: 980, y: 90 }, 2500);
    }
    await sleep(4000);
  },

  // The + on a piece: the palette of shapes; then the shape grown before.
  async "07-grow"(page) {
    await open(page, talk);
    const first = ".card-item:has(.sem)";
    const step = page.locator(`${first} .sem-step`).nth(1);
    const b = await step.boundingBox();
    await glide(page, { x: b.x, y: b.y }, { x: 520, y: 260 }, 10);
    await sleep(600);
    start();
    await sleep(200);
    await step.hover();
    await sleep(600);
    await step.locator(".grow-btn").first().click();
    await sleep(1200);
    for (const label of ["Why?", "Steps", "Break it down", "Two ways"]) {
      await hover(page, `.grow-shapes button:text-is("${label}")`, 400);
      await sleep(700);
    }
    await page.keyboard.press("Escape");
    await page.mouse.click(60, 1000);
    await sleep(600);
    const g = await box(page, `${first} .grown`);
    if (g) await glide(page, { x: g.x, y: g.y }, { x: 520, y: 300 }, 1500);
    await sleep(3000);
  },

  // The whole canvas: nothing moved.
  async "08-place"(page) {
    await open(page, talk);
    await bring(page, "img.source-image", 160, 160, 10);
    await sleep(600);
    start();
    await sleep(200);
    await zoom(page, { x: 400, y: 300 }, 7, 4000);
    await sleep(2500);
  },

  // A lecture plays; Stop; the frame and transcript land; the explanation of a box on it.
  async "09-video"(page) {
    await open(page, lecture);
    await bring(page, ".video-item", 60, 120, 10);
    await zoom(page, { x: 60, y: 120 }, 2, 300);
    await sleep(600);
    start();
    await sleep(600);
    // The player stays on its title card: headless Chrome can't draw YouTube's video once it seeks.
    await sleep(2000);
    // (Clicking Stop freezes the page while it's being screen-recorded headless, so the shot
    // points at it and then tours a moment stopped at before.)
    await hover(page, ".video-stop", 900);
    await sleep(2500);
    const at = async (sel) =>
      page.evaluate((sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y } : null;
      }, sel);
    const frame = await at("img.source-image");
    if (frame) await glide(page, frame, { x: 140, y: 150 }, 2200);
    await sleep(2800);
    const c = await at(".card-item:has(.sem)");
    if (c) await glide(page, c, { x: 1100, y: 130 }, 2000);
    await sleep(2000);
    await hover(page, ".resume-btn", 800);
    await sleep(2500);
  },

  // Sources found, and where the subject is taught.
  async "10-sources"(page) {
    await open(page, talk);
    const first = ".card-item:has(.sem)";
    const t = await box(page, `${first} .taught`);
    await glide(page, { x: t.x, y: t.y }, { x: 600, y: 420 }, 10);
    await sleep(600);
    start();
    await sleep(200);
    await zoom(page, { x: 600, y: 480 }, -3, 1200);
    await sleep(9000);
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);
for (const id of want) {
  const ctx = await newScene();
  const page = await ctx.newPage();
  t0 = Date.now();
  current = id;
  page.setDefaultTimeout(20_000);
  log("recording", id);
  try {
    await scenes[id](page);
  } catch (err) {
    log(id, "failed:", err.message);
  }
  const video = page.video();
  await page.close();
  await ctx.close();
  const path = await video.path();
  renameSync(path, `${DIR}clips/${id}.webm`);
  log("saved", id);
}
await browser.close();
const prev = (() => {
  try {
    return JSON.parse(readFileSync(`${DIR}clips/marks.json`, "utf8"));
  } catch {
    return {};
  }
})();
writeFileSync(`${DIR}clips/marks.json`, JSON.stringify({ ...prev, ...marks }, null, 2));
// Pages opened by the context itself (the persistent profile's first tab) also record; drop those.
rmSync(`${DIR}raw`, { recursive: true, force: true });
void readdirSync;
