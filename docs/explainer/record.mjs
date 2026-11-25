// Records the explainer's app footage, one clip per scene, from the demo canvases prep.mjs built.
// Usage: node record.mjs [scene ...]   (default: all app scenes)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const DIR = new URL(".", import.meta.url).pathname;
const SITE = "https://librarian.9ol.es";
const { talk, lecture, page: pageCanvas, pageCard, notebook } = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
const CALL = JSON.parse(readFileSync(`${DIR}call.json`, "utf8"));
const W = 1920;
const H = 1080;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
mkdirSync(`${DIR}clips`, { recursive: true });

// Recorded in plain contexts carrying the demo visitor's session (saved from the profile prep used).
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const newScene = async () => {
  const ctx = await browser.newContext({
    storageState: `${DIR}state.json`,
    viewport: { width: W, height: H },
    recordVideo: { dir: `${DIR}raw`, size: { width: W, height: H } },
  });
  // Headless Chrome can't reach a speech service: the recognizer is driven by the scene itself,
  // and the librarian's voice (added in the edit, as narration) is silent here.
  await ctx.addInitScript(() => {
    window.webkitSpeechRecognition = window.SpeechRecognition = class {
      constructor() {
        window.__rec = this;
      }
      start() {}
      stop() {}
      abort() {}
    };
    if (window.speechSynthesis) speechSynthesis.speak = (u) => setTimeout(() => u.onend?.(), 2500);
  });
  return ctx;
};

// Waits in a scene are stretched to its narration: scenes were timed against the narration in
// audio-before/ (when there is one), and run longer or shorter as the narration in audio/ does.
let PACE = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
const seconds = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());
function paceFor(id) {
  try {
    return (seconds(`${DIR}audio/${id}.wav`) + 1.1) / (seconds(`${DIR}audio-before/${id}.wav`) + 1.1);
  } catch {
    return 1;
  }
}

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
  // Keep the shot clean (hidden, not removed: React still owns it).
  await page.addStyleTag({ content: ".start-open { display: none !important; }" });
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

/** Opens the bialgebra canvas for a shot, without the main card's conversation. */
async function bialgebraOpen(page) {
  const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
  await open(page, ids.bialgebra);
  await page.addStyleTag({ content: `.card-item[data-card-id="${ids.bialgebraCard}"] .chat { display: none !important; } .start-dock { transform: scale(1.7); transform-origin: top center; }` });
  return ids;
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


// ---- Things drawn over the page for the shot: a cursor (headless Chrome draws none), captions,
// a title card, a box being dragged out. All fixed to the viewport, above everything.
async function overlay(page) {
  await page.addStyleTag({
    content: `
      #fx-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none;
        transition: transform var(--t, 0ms) cubic-bezier(.45,.05,.35,1); }
      #fx-caption { position: fixed; left: 1490px; top: 50%; transform: translate(-50%, -50%); width: 640px; z-index: 2147483646; pointer-events: none;
        font: 600 54px/1.2 Inter, system-ui, sans-serif; color: #1d1d1b; text-align: center; padding: 22px 48px; border-radius: 18px;
        background: rgba(246,245,241,.94); box-shadow: 0 10px 40px rgba(0,0,0,.18); opacity: 0; transition: opacity 700ms; }
      #fx-caption b { color: #2f5fb3; font-weight: 700; }
      #fx-card { position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; opacity: 0; transition: opacity 800ms;
        background-size: cover; background-position: center; }
      #fx-box { position: fixed; z-index: 2147483644; pointer-events: none; border: 2px solid #2f5fb3; background: rgba(47,95,179,.08); display: none; }
      .fx-on { opacity: 1 !important; }
    `,
  });
  await page.evaluate(() => {
    const c = document.createElement("div");
    c.id = "fx-cursor";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2 L3 20 L8 15.5 L11.5 23 L14.5 21.6 L11 14.3 L18 14.3 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    for (const id of ["fx-caption", "fx-card", "fx-box"]) {
      const d = document.createElement("div");
      d.id = id;
      document.body.appendChild(d);
    }
    document.body.appendChild(c);
  });
}
/** Moves the drawn cursor (and the real pointer, for hover effects) to (x, y) over `ms`. */
async function cursor(page, x, y, ms = 600) {
  await page.evaluate(([x, y, ms]) => {
    const c = document.getElementById("fx-cursor");
    c.style.setProperty("--t", `${ms}ms`);
    c.style.transform = `translate(${x}px, ${y}px)`;
  }, [x, y, ms]);
  // The real pointer jumps (hover effects); the drawn one glides, without holding up the shot.
  await page.mouse.move(x, y);
}
const caption = (page, html) =>
  page.evaluate((html) => {
    const c = document.getElementById("fx-caption");
    if (html) c.innerHTML = html;
    c.classList.toggle("fx-on", Boolean(html));
  }, html);

const card = (subject) => `.card-item:has(.asked-text:text-is("${subject}"))`;

const scenes = {
  // A card's conversation asks for lectures; the gallery that came of it, each with its channel.
  async "10d-ask"(page) {
    const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
    await open(page, ids.lagrange);
    await overlay(page);
    const P = `.card-item[data-card-id="${ids.lagrangeCard}"]`;
    // The asks, at the foot of the page card's conversation.
    const first = page.locator(`${P} .chat-msg, ${P} .chat-turn, ${P} .chat-text`).first();
    const fb = await first.boundingBox();
    if (fb) await glide(page, { x: fb.x, y: fb.y }, { x: 260, y: 300 }, 10);
    await sleep(600);
    start();
    await cursor(page, 700, 700, 0);
    await sleep(600);
    await cursor(page, fb ? 560 : 700, 330, 900);
    await sleep(2600);
    const V = `.card-item[data-card-id="${ids.videos}"]`;
    const vb = await box(page, V);
    await glide(page, { x: vb.x, y: vb.y }, { x: 420, y: 80 }, 2200);
    await sleep(500);
    const vids = await page.locator(`${V} .video`).all();
    for (const v of vids.slice(0, 4)) {
      const b = await v.boundingBox();
      if (!b) continue;
      await cursor(page, b.x + b.width * 0.6, b.y + b.height - 12, 700);
      await sleep(1500);
    }
    await sleep(2500);
  },

  // A plot read with the pointer, a graph rearranged, a table charting itself, a map going to a place.
  async "10e-figures"(page) {
    const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
    await open(page, ids.lagrange);
    await overlay(page);
    const at = (id) => `.card-item[data-card-id="${id}"]`;
    const pb = await box(page, at(ids.plot));
    await glide(page, { x: pb.x, y: pb.y }, { x: 480, y: 70 }, 10);
    await sleep(600);
    start();
    // Plot: the pointer runs along it, reading values.
    const svg = await box(page, `${at(ids.plot)} .figure-svg`);
    await cursor(page, svg.x + 80, svg.y + svg.height * 0.5, 0);
    for (let i = 0; i <= 30; i++) {
      await cursor(page, svg.x + 80 + (svg.width - 120) * (i / 30), svg.y + svg.height * 0.5, 0);
      await sleep(80);
    }
    await sleep(500);
    // Graph: a node dragged somewhere better.
    const gb = await box(page, at(ids.graph));
    await glide(page, { x: gb.x, y: gb.y }, { x: 480, y: 70 }, 1300);
    await sleep(300);
    const node = page.locator(`${at(ids.graph)} .fig-node`).nth(2);
    const nb = await node.boundingBox();
    if (nb) {
      const x0 = nb.x + nb.width / 2, y0 = nb.y + nb.height / 2;
      await cursor(page, x0, y0, 500);
      await sleep(600);
      await page.mouse.down();
      for (let i = 1; i <= 20; i++) {
        await cursor(page, x0 + 150 * (i / 20), y0 + 70 * (i / 20), 0);
        await sleep(40);
      }
      await page.mouse.up();
    }
    await sleep(900);
    // Table: charting itself.
    const tb = await box(page, at(ids.table));
    await glide(page, { x: tb.x, y: tb.y }, { x: 480, y: 70 }, 1300);
    await sleep(500);
    const chartIt = page.locator(`${at(ids.table)} button:has-text("Chart it")`);
    const cb = await chartIt.boundingBox();
    if (cb) {
      await cursor(page, cb.x + cb.width / 2, cb.y + cb.height / 2, 500);
      await sleep(600);
      await chartIt.click();
    }
    await sleep(2200);
    // Map: a place picked from its list.
    const mb = await box(page, at(ids.map));
    await glide(page, { x: mb.x, y: mb.y }, { x: 480, y: 70 }, 1300);
    await sleep(800);
    const place = page.locator(`${at(ids.map)} .map-places .link`).nth(1);
    const lb = await place.boundingBox();
    if (lb) {
      await cursor(page, lb.x + lb.width / 2, lb.y + lb.height / 2, 600);
      await sleep(600);
      await place.click();
    }
    await sleep(3500);
  },

  // The Goals panel: the goal, what it needed, the side trips; one lights its cards, one is walked to.
  async "10f-goals"(page) {
    const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
    await open(page, ids.lagrange);
    await overlay(page);
    // Zoomed out, so the cards a goal lights show.
    await zoom(page, { x: 1200, y: 500 }, 10, 600);
    const pb = await box(page, `.card-item[data-card-id="${ids.lagrangeCard}"]`);
    await glide(page, { x: pb.x, y: pb.y }, { x: 420, y: 80 }, 10);
    await sleep(800);
    start();
    const gbtn = page.locator('button:has-text("Goals")').first();
    const gb = await gbtn.boundingBox();
    await cursor(page, 1400, 600, 0);
    await sleep(400);
    await cursor(page, gb.x + gb.width / 2, gb.y + gb.height / 2, 900);
    await sleep(1100);
    await gbtn.click();
    await sleep(1600);
    const rows = await page.locator(".goal-row .goal-text").all();
    for (const r of rows) {
      const b = await r.boundingBox();
      if (!b) continue;
      await cursor(page, b.x + 60, b.y + b.height / 2, 600);
      await page.mouse.move(b.x + 60, b.y + b.height / 2);
      await sleep(1700);
    }
    // Walk to the subgoal's card.
    const sub = page.locator(".goal-row.subgoal .goal-text").first();
    const sb = await sub.boundingBox();
    if (sb) {
      await cursor(page, sb.x + 60, sb.y + sb.height / 2, 500);
      await sleep(400);
      await sub.click();
    }
    await sleep(3500);
  },

  // A call: pointing at Berlin on the map, asked why; then "the chart" numbered three ways, and picked.
  async "10g-which"(page) {
    const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
    const CALL2 = JSON.parse(readFileSync(`${DIR}call2.json`, "utf8"));
    await open(page, ids.lagrange);
    await overlay(page);
    let turn = 0;
    await page.route("**/call", async (route) => {
      const t = CALL2.turns[turn++] ?? CALL2.turns.at(-1);
      await sleep(1500);
      const { text: _t, pick: _p, looked: _l, ...reply } = t;
      await route.fulfill({ json: reply });
      if (reply.removed?.length) await page.evaluate((id) => document.body.classList.add(`gone-${id}`), reply.removed[0]);
    });
    await page.addStyleTag({ content: CALL2.turns.flatMap((t) => t.removed ?? []).map((id) => `body.gone-${id} .card-item[data-card-id="${id}"] { opacity: 0; transition: opacity 600ms; }`).join("\n") });
    // The map at the top, clear of the call bar.
    const mb0 = await box(page, `.card-item[data-card-id="${ids.map}"]`);
    await glide(page, { x: mb0.x, y: mb0.y }, { x: 520, y: 70 }, 10);
    await sleep(1200);
    start();
    const t0 = Date.now();
    await cursor(page, 1500, 500, 0);
    await page.click(".call-btn");
    await sleep(1200);
    // Pointing at Berlin on the map.
    const berlin = await page.evaluate((i) => {
      const box = [...document.querySelectorAll(".map-box")].pop();
      const ol = box?.__ol;
      if (!ol) return null;
      // By its own label: a vector source doesn't keep features in the order they were added.
      const f = ol.getLayers().item(1).getSource().getFeatures().find((f) => f.get("about")?.startsWith(`place ${i + 1} of `));
      const px = ol.getPixelFromCoordinate(f.getGeometry().getCoordinates());
      const r = box.getBoundingClientRect();
      const k = r.width / box.offsetWidth;
      return { x: r.left + px[0] * k, y: r.top + px[1] * k };
    }, CALL2.berlin);
    if (berlin) {
      await cursor(page, berlin.x, berlin.y, 900);
      await sleep(400);
      for (let i = 0; i < 3; i++) {
        await page.mouse.move(berlin.x + (i % 2 ? 2 : -2), berlin.y);
        await sleep(120);
      }
    }
    const sayIt = async (text) => {
      const words = text.split(" ");
      await page.evaluate(() => window.__rec?.onspeechstart?.());
      for (let i = 1; i <= words.length; i++) {
        await page.evaluate((t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: t } }, { isFinal: false })] }), words.slice(0, i).join(" "));
        await sleep(230);
      }
      await page.evaluate((t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: t } }, { isFinal: true })] }), text);
    };
    await sayIt(CALL2.turns[0].text);
    await sleep(4600);
    // Up to the figures, for "the chart".
    await zoom(page, { x: 1200, y: 400 }, 4, 500);
    const tb = await box(page, `.card-item[data-card-id="${ids.table}"]`);
    await glide(page, { x: tb.x, y: tb.y }, { x: 520, y: 330 }, 1200);
    await cursor(page, 1500, 420, 700);
    await sleep(500);
    await sayIt(CALL2.turns[1].text);
    await sleep(3000);
    // Picking a number from the call bar.
    const pick = CALL2.turns[2]?.pick;
    const chip = page.locator(`.call-choices button:has(b:text-is("${pick}"))`);
    const cb = await chip.boundingBox();
    if (cb) {
      await cursor(page, cb.x + cb.width / 2, cb.y + cb.height / 2, 700);
      await sleep(500);
      log("which: pick at", ((Date.now() - t0) / 1000).toFixed(1));
      await chip.click();
    }
    await sleep(5000);
  },

  // ---- The bialgebra film: one Wikipedia page, made readable ----
  // (bialgebraOpen hides the main card's conversation, which only shows how the canvas was built.)

  // The page as anyone sees it, then closer, read along its first paragraph.
  async "b1-page"(page) {
    await page.goto("https://en.wikipedia.org/wiki/Bialgebra", { waitUntil: "networkidle" });
    await page.evaluate(() => document.querySelectorAll("#siteNotice, #centralNotice").forEach((e) => e.remove()));
    await page.addStyleTag({ content: "html { transform-origin: 0 0; transition: transform 2600ms cubic-bezier(.4,0,.2,1); }" });
    const at = await page.evaluate(() => {
      const p = [...document.querySelectorAll("#mw-content-text .mw-parser-output p")].find((p) => p.textContent.includes("bialgebra"));
      const r = p.getBoundingClientRect();
      const f = [...document.querySelectorAll("h2")].find((h) => /Formal definition/.test(h.textContent)).getBoundingClientRect();
      return { x: r.x, y: r.y + scrollY, f: f.y + scrollY };
    });
    const k = 1.6;
    const look = (y) => page.evaluate(([k, x, y]) => (document.documentElement.style.transform = `translate(${x}px, ${y}px) scale(${k})`), [k, 70 - at.x * k, y]);
    await sleep(800);
    start();
    await sleep(2400);
    // Closer on the opening paragraph; then down into the formal definition and its diagrams.
    await look(250 - at.y * k);
    await sleep(4200);
    await look(90 - at.f * k);
    await sleep(3800);
    await look(90 - (at.f + 330) * k);
    await sleep(6000);
  },

  // The link given to Librarian; the page drawn as shapes, section by section of the overview.
  async "b2-shapes"(page) {
    const ids = await bialgebraOpen(page);
    const C = `.card-item[data-card-id="${ids.bialgebraCard}"]`;
    await page.addStyleTag({
      content: `
        .card-item:not([data-card-id="${ids.bialgebraCard}"]), .connectors { opacity: 0 !important; }
        ${C} .page-sections, ${C} .grown { display: none !important; }
        ${C} .sem-section, ${C} .sem-title, ${C} .card-head { transition: opacity 700ms, transform 700ms; }
        body:not(.fx-in) ${C} { opacity: 0; }
        ${C} { transition: opacity 600ms; }
        body:not(.fx-why) ${C} .facet-why, body:not(.fx-what) ${C} .facet-what,
        body:not(.fx-parts) ${C} .facet-parts, body:not(.fx-here) ${C} .facet-here, body:not(.fx-here) ${C} .sem-aside { opacity: 0; transform: translateY(12px); }
      `,
    });
    await bring(page, C, 470, 90, 10);
    await sleep(600);
    start();
    await sleep(500);
    // Given the link: typed into Add.
    const add = page.locator("button", { hasText: "Add" }).first();
    await add.click();
    await sleep(500);
    await page.keyboard.type("https://en.wikipedia.org/wiki/Bialgebra", { delay: 45 });
    await sleep(900);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.querySelector(".start-dock")?.remove());
    const body = (cls) => page.evaluate((c) => document.body.classList.add(c), cls);
    await body("fx-in");
    for (const [cls, ms] of [["fx-why", 2600], ["fx-what", 2600], ["fx-parts", 3200], ["fx-here", 2400]]) {
      await sleep(ms * 0.4);
      await body(cls);
      if (cls === "fx-parts") {
        const pb = await box(page, `${C} .facet-parts`);
        if (pb && pb.y > 560) await glide(page, { x: pb.x, y: pb.y }, { x: pb.x, y: 260 }, 1400);
      }
      await sleep(ms * 0.6);
    }
    await sleep(3000);
  },

  // Down through the whole page, section by section.
  async "b3-sections"(page) {
    const ids = await bialgebraOpen(page);
    const C = `.card-item[data-card-id="${ids.bialgebraCard}"]`;
    await page.addStyleTag({ content: `.card-item:not([data-card-id="${ids.bialgebraCard}"]), .connectors { opacity: 0 !important; } ${C} .grown:not(.page-sections .grown) { display: none !important; }` });
    await page.evaluate((c) => document.querySelectorAll(`${c} details.page-section`).forEach((d) => (d.open = true)), C);
    await sleep(800);
    const secs = await box(page, `${C} .page-sections`);
    await glide(page, { x: secs.x, y: secs.y }, { x: 470, y: 260 }, 10);
    await sleep(600);
    start();
    await sleep(1000);
    for (const n of [2, 3, 4, 5, 6]) {
      const b = await box(page, `${C} .page-section:nth-of-type(${n})`);
      if (b) await glide(page, { x: b.x, y: b.y }, { x: 470, y: 110 }, 1800);
      await sleep(500);
    }
    await sleep(3000);
  },

  // A piece still unclear: its + menu, close up; the example it grows.
  async "b4-grow"(page) {
    const ids = await bialgebraOpen(page);
    const C = `.card-item[data-card-id="${ids.bialgebraCard}"]`;
    await page.addStyleTag({
      content: `.card-item:not([data-card-id="${ids.bialgebraCard}"]), .connectors { opacity: 0 !important; }
        body:not(.fx-grown) ${C} .grown:not(.page-sections .grown) { display: none !important; }`,
    });
    const piece = page.locator(`${C} [data-a="part-3"]`);
    const b = await piece.boundingBox();
    await glide(page, { x: b.x, y: b.y }, { x: 700, y: 300 }, 10);
    await sleep(600);
    start();
    await sleep(400);
    await piece.hover();
    await sleep(500);
    const pb = await piece.locator(".grow-btn").first().boundingBox();
    const anchor = { x: Math.min(pb.x, 760), y: pb.y - 80 };
    await zoom(page, anchor, -5, 1200);
    const pz = await piece.locator(".grow-btn").first().boundingBox();
    if (pz && (pz.x > 1000 || pz.y > 500)) await glide(page, { x: pz.x, y: pz.y }, { x: Math.min(pz.x, 1000), y: Math.min(pz.y, 300) }, 700);
    await sleep(300);
    await piece.hover();
    await sleep(200);
    await piece.locator(".grow-btn").first().click();
    await sleep(800);
    for (const label of ["Why?", "Steps", "For example"]) {
      await hover(page, `.grow-shapes button:text-is("${label}")`, 400);
      await sleep(650);
    }
    // Closed with its own +, as a reader would; then the example it grows.
    await piece.locator(".grow-btn").first().click();
    await page.evaluate(() => document.body.classList.add("fx-grown"));
    await sleep(500);
    const g = await box(page, `${C} .grown`);
    if (g) await glide(page, { x: g.x, y: g.y }, { x: Math.max(80, Math.min(g.x, 700)), y: 260 }, 1200);
    await sleep(3500);
  },

  // What people already wrote and taught, hung from the page: course notes, lectures, papers.
  async "b5-sources"(page) {
    const ids = await bialgebraOpen(page);
    const m = ids.bialgebraMade;
    const card = (id) => `.card-item[data-card-id="${id}"]`;
    // The notebook the call found, then what hangs from the page: course notes, lectures, papers.
    await bring(page, card(ids.lectureNotebook), 520, 90, 10);
    await sleep(600);
    start();
    await sleep(4200);
    await bring(page, card(m.links), 900, 90, 1500);
    await sleep(4300);
    await bring(page, card(m.videos), 900, 90, 1500);
    await sleep(3600);
    await bring(page, card(m.papers), 900, 90, 1500);
    await sleep(4500);
  },

  // The whole tree, and the page it came from.
  async "b6-whole"(page) {
    const ids = await bialgebraOpen(page);
    await bring(page, `.card-item[data-card-id="${ids.bialgebraCard}"]`, 700, 90, 10);
    await overlay(page);
    const wiki = readFileSync(`${DIR}shots/02-climb.png`).toString("base64");
    await page.addStyleTag({ content: `#fx-card { inset: auto; left: 40px; bottom: 40px; width: 560px; height: 315px; border-radius: 10px; box-shadow: 0 18px 50px rgba(0,0,0,.25); }` });
    await page.evaluate((png) => (document.getElementById("fx-card").style.backgroundImage = `url(data:image/png;base64,${png})`), wiki);
    await sleep(600);
    start();
    await zoom(page, { x: 700, y: 200 }, 13, 3000);
    await sleep(600);
    await page.evaluate(() => document.getElementById("fx-card").classList.add("fx-on"));
    await sleep(6000);
  },

  // A lecture on the same canvas, stopped where it loses you; the board's definition boxed and explained.
  async "c1-lecture"(page) {
    const ids = await bialgebraOpen(page);
    const F = ids.lectureFrame;
    const LC = `.card-item[data-card-id="${ids.lectureCard}"]`;
    await page.addStyleTag({
      content: `
        [data-image-id="${F}"] { transition: opacity 700ms; }
        body:not(.fx-frame) [data-image-id="${F}"] { opacity: 0 !important; }
        body:not(.fx-region) .region { opacity: 0 !important; }
        ${LC} { transition: opacity 600ms; }
        body:not(.fx-card) ${LC}, body:not(.fx-card) .connectors { opacity: 0 !important; }
        ${LC} .grown, ${LC} .chat, ${LC} .clarify, ${LC} .look, .card-item[data-card-id="${ids.lectureNotebook}"] { display: none !important; }
        ${LC} .sem-section { transition: opacity 600ms, transform 600ms; }
        body:not(.fx-why) ${LC} .facet-why, body:not(.fx-what) ${LC} .facet-what,
        body:not(.fx-parts) ${LC} .facet-parts, body:not(.fx-here) ${LC} .facet-here, body:not(.fx-here) ${LC} .sem-aside { opacity: 0; transform: translateY(12px); }
      `,
    });
    // 100%, so the frame and its card sit side by side.
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()))?.click());
    await sleep(600);
    await zoom(page, { x: 40, y: 100 }, -2, 300);
    await bring(page, ".video-item", 40, 90, 10);
    await overlay(page);
    await sleep(600);
    start();
    await sleep(1400);
    await hover(page, ".video-stop", 900);
    await sleep(900);
    await page.evaluate(() => document.body.classList.add("fx-frame"));
    await sleep(900);
    await bring(page, `img[data-image-id="${F}"]`, 30, 110, 1300);
    await sleep(500);
    // The box, drawn over the definition's first line (in the frame's own pixels).
    const fb = await box(page, `img[data-image-id="${F}"]`);
    const k = fb.width / 1920;
    const reg = { x: fb.x + 110 * k, y: fb.y + 245 * k, w: 1150 * k, h: 95 * k };
    await cursor(page, reg.x - 2, reg.y - 2, 700);
    await sleep(750);
    await page.evaluate(([x, y]) => Object.assign(document.getElementById("fx-box").style, { display: "block", left: `${x}px`, top: `${y}px`, width: "0px", height: "0px" }), [reg.x - 2, reg.y - 2]);
    for (let i = 1; i <= 20; i++) {
      const w = (reg.w + 4) * (i / 20);
      const h = (reg.h + 4) * Math.min(1, (i / 20) * 1.4);
      await page.evaluate(([w, h]) => Object.assign(document.getElementById("fx-box").style, { width: `${w}px`, height: `${h}px` }), [w, h]);
      await page.evaluate(([x, y]) => (document.getElementById("fx-cursor").style.cssText += `;--t:0ms;transform:translate(${x}px,${y}px)`), [reg.x - 2 + w, reg.y - 2 + h]);
      await new Promise((r) => setTimeout(r, 40));
    }
    await sleep(300);
    await page.evaluate(() => (document.getElementById("fx-box").style.display = "none"));
    const body = (c) => page.evaluate((c) => document.body.classList.add(c), c);
    await body("fx-region");
    await cursor(page, reg.x + reg.w + 60, reg.y + 220, 600);
    await body("fx-card");
    for (const c of ["fx-why", "fx-what", "fx-parts", "fx-here"]) {
      await sleep(900);
      await body(c);
    }
    await sleep(4000);
  },

  // The call: asked aloud while pointing at pieces of the lecture's card; it answers, and the
  // canvas grows. The real call (call3.json) is replayed in time with the call's audio.
  async "c2-call"(page) {
    const ids = await bialgebraOpen(page);
    const LC = `.card-item[data-card-id="${ids.lectureCard}"]`;
    const NB = `.card-item[data-card-id="${ids.lectureNotebook}"]`;
    const CALL3 = JSON.parse(readFileSync(`${DIR}call3.json`, "utf8")).turns;
    const S = JSON.parse(readFileSync(`${DIR}call3-schedule.json`, "utf8"));
    const shapes = ["why", "example", "then"];
    await page.addStyleTag({
      content: `
        ${LC} .chat, ${LC} .clarify, ${LC} .look { display: none !important; }
        ${shapes.map((sh, i) => `body:not(.fx-g${i + 1}) ${LC} .grown-${sh}`).join(", ")}, body:not(.fx-nb) ${NB} { display: none !important; }
      `,
    });
    let turn = 0;
    await page.route("**/call", async (route) => {
      const i = turn++;
      const t = CALL3[i] ?? CALL3.at(-1);
      const a = S[`a${i + 1}`];
      // Answered as it was: spoken from when its audio starts.
      const wait = t0 + a.start * 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await route.fulfill({ json: { say: t.reply.short ?? t.reply.say, did: t.reply.did } });
      await page.evaluate((n) => document.body.classList.add(`fx-g${n}`), i + 1);
    });
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()))?.click());
    await sleep(600);
    await zoom(page, { x: 40, y: 100 }, -2, 300);
    await bring(page, `img[data-image-id="${ids.lectureFrame}"]`, -500, 110, 10);
    await sleep(800);
    start();
    const t0 = Date.now();
    const at = async (t) => {
      const w = t0 + t * 1000 - Date.now();
      if (w > 0) await new Promise((r) => setTimeout(r, w));
    };
    await hover(page, ".call-btn", 600);
    await page.click(".call-btn");
    const sayIt = async (text, from, to) => {
      const words = text.split(" ");
      await page.evaluate(() => window.__rec?.onspeechstart?.());
      for (let i = 1; i <= words.length; i++) {
        await at(from + ((to - from) * i) / (words.length + 1));
        await page.evaluate((t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: t } }, { isFinal: false })] }), words.slice(0, i).join(" "));
      }
      await at(to);
      await page.evaluate((t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: t } }, { isFinal: true })] }), text);
    };
    const point = async (key, t) => {
      const b = await box(page, `${LC} [data-a="${key}"]`);
      if (!b) return;
      await page.mouse.move(b.x + Math.min(120, b.width / 2), b.y + b.height / 2, { steps: 25 });
      await at(t);
    };
    for (let i = 0; i < CALL3.length; i++) {
      const q = S[`q${i + 1}`];
      const key = CALL3[i].pointing.key;
      // Bring the piece into a clear part of the frame, then point at it while asking.
      await at(q.start - 1.6);
      const pb = await box(page, `${LC} [data-a="${key}"]`);
      if (pb && (pb.x > 1300 || pb.y > 600 || pb.y < 120)) await glide(page, { x: pb.x, y: pb.y }, { x: Math.min(pb.x, 900), y: 300 }, 700);
      await point(key, q.start);
      await sayIt(CALL3[i].text, q.start, q.end);
      if (i === 1) {
        // The example it found is a notebook: shown, beside the card, while it's described.
        await at(S.a2.start + 3.5);
        await page.evaluate(() => document.body.classList.add("fx-nb"));
        await sleep(400);
        const nb = await box(page, NB);
        if (nb) await glide(page, { x: nb.x, y: nb.y }, { x: 900, y: 120 }, 1400);
        await at(S.a2.end - 1);
      }
    }
    await at(S.a3.end + 0.6);
  },

  // The opening, one continuous shot over the narration of scenes 01 to 04: the slide and the
  // problem (a caption, then the climb), then a box drawn around the words, and the card building
  // beside it, section by section, as the narration names each section.
  async "00-open"(page) {
    const { talkCard, talkDeeper } = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
    await open(page, talk);
    // 100%: the slide on the left, room on the right for the card.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()));
      if (b && b.textContent.trim() !== "100%") b.click();
    });
    await sleep(600);
    await bring(page, "img.source-image", 150, 200, 10);
    const C = `.card-item[data-card-id="${talkCard}"]`;
    await page.addStyleTag({
      content: `
        .card-item[data-card-id="${talkDeeper}"], .connectors path:nth-child(2) { display: none !important; }
        ${C} { transition: opacity 700ms, transform 700ms; }
        ${C} .sem-section { transition: opacity 600ms, transform 600ms; }
        body:not(.fx-card-in) ${C}, body:not(.fx-card-in) .connectors path:first-child { opacity: 0; transform: translateY(14px); }
        body:not(.fx-region) .region { opacity: 0; }
        .region { transition: opacity 400ms; }
        body:not(.fx-why) ${C} .facet-why, body:not(.fx-what) ${C} .facet-what,
        body:not(.fx-parts) ${C} .facet-parts, body:not(.fx-here) ${C} .facet-here { opacity: 0; transform: translateY(10px); }
      `,
    });
    const climb = readFileSync(`${DIR}shots/02-climb.png`).toString("base64");
    await overlay(page);
    await page.evaluate((png) => (document.getElementById("fx-card").style.backgroundImage = `url(data:image/png;base64,${png})`), climb);
    const body = (cls, on = true) => page.evaluate(([c, on]) => document.body.classList.toggle(c, on), [cls, on]);
    await cursor(page, 1300, 760, 0);
    await sleep(800);
    // Seconds into the shot, by the narration (segments: hook 15.2 s, climb 14.6 s, idea 13.2 s, descend 15.4 s).
    start();
    const t0 = Date.now();
    // The times below were set against the first narration's segments; each is stretched to fit
    // the narration now in audio/, segment by segment, so the shot keeps time with any voice.
    const OLD = [15.175, 14.625, 13.15, 15.425];
    const NEW = ["01-hook", "02-climb", "03-idea", "04-descend"].map((id) => 0.45 + seconds(`${DIR}audio/${id}.wav`) + 0.65);
    const map = (t) => {
      let o = 0, n = 0;
      for (let i = 0; i < 4; i++) {
        if (t <= o + OLD[i] || i === 3) return n + ((t - o) * NEW[i]) / OLD[i];
        o += OLD[i];
        n += NEW[i];
      }
    };
    const at = async (t) => {
      const wait = t0 + map(t) * 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    };
    const reg = await page.evaluate(() => {
      const r = document.querySelector(".region").getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    // Hook: reading down the slide, then stuck on the words.
    await at(1.5);
    await cursor(page, 520, 470, 1800);
    await at(4.5);
    await cursor(page, 760, 620, 1600);
    await at(7.5);
    await cursor(page, 560, 735, 1400);
    await at(9.6);
    await cursor(page, reg.x + reg.w * 0.55, reg.y + reg.h + 6, 1200);
    await at(11.2);
    await caption(page, "One unfamiliar word goes by,<br>and you're <b>lost</b>.");
    await at(14.6);
    await caption(page, "");
    // Climb: the title card over the canvas, then away.
    await at(15.3);
    await page.evaluate(() => document.getElementById("fx-card").classList.add("fx-on"));
    await at(29.0);
    await page.evaluate(() => document.getElementById("fx-card").classList.remove("fx-on"));
    // Idea: the box, drawn around the words, then the card lands beside it.
    await at(31.0);
    await cursor(page, 900, 620, 1500);
    await at(37.6);
    await cursor(page, reg.x - 2, reg.y - 2, 900);
    await at(38.7);
    await page.evaluate(([x, y]) => {
      const b = document.getElementById("fx-box");
      Object.assign(b.style, { display: "block", left: `${x}px`, top: `${y}px`, width: "0px", height: "0px" });
    }, [reg.x - 2, reg.y - 2]);
    for (let i = 1; i <= 24; i++) {
      const k = i / 24;
      const w = (reg.w + 4) * k;
      const h = (reg.h + 4) * Math.min(1, k * 1.4);
      await page.evaluate(([w, h]) => Object.assign(document.getElementById("fx-box").style, { width: `${w}px`, height: `${h}px` }), [w, h]);
      await page.evaluate(([x, y]) => (document.getElementById("fx-cursor").style.cssText += `;--t:0ms;transform:translate(${x}px,${y}px)`), [reg.x - 2 + w, reg.y - 2 + h]);
      await sleep(45);
    }
    await sleep(350);
    await page.evaluate(() => (document.getElementById("fx-box").style.display = "none"));
    await body("fx-region");
    await cursor(page, reg.x + reg.w + 120, reg.y + 260, 700);
    await at(40.6);
    log("open: box done at", ((Date.now() - t0) / 1000).toFixed(1), "(planned 40.6)");
    await body("fx-card-in");
    // Descend: each section as it's named.
    const T4 = 15.175 + 14.625 + 13.15;
    const D4 = 14.325;
    const said = (frac) => T4 + 0.45 + frac * D4;
    const show = async (cls, sel, t) => {
      await at(t - 0.9);
      const b = await box(page, `${C} ${sel}`);
      const c = await box(page, C);
      // The card to the middle of the frame, and the section up to where it's read.
      if (b && c && (b.y > 620 || b.y < 120 || c.x > 700)) await glide(page, { x: c.x, y: b.y }, { x: 560, y: b.y > 620 || b.y < 120 ? 260 : b.y }, 900);
      await at(t);
      await body(cls);
    };
    await show("fx-why", ".facet-why", said(52 / 228));
    await show("fx-what", ".facet-what", said(80 / 228));
    await show("fx-parts", ".facet-parts", said(97 / 228));
    await show("fx-here", ".facet-here", said(113 / 228));
    await at(T4 + 15.4 + 0.5);
    log("open: card in at", ((Date.now() - t0) / 1000).toFixed(1));
  },

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
    // Close in on the piece with the canvas's own zoom, so the menu that opens from it can be read.
    // Anchored on the +, which stays put while everything grows around it: the menu opens from it.
    const pb = await step.locator(".grow-btn").first().boundingBox();
    const anchor = { x: Math.min(pb.x, 760), y: pb.y - 80 };
    await zoom(page, anchor, -5, 1200);
    // Then slid left until the menu, which opens to the right of the +, fits in the frame.
    const pz = await step.locator(".grow-btn").first().boundingBox();
    if (pz && pz.x > 1000) await glide(page, { x: pz.x, y: pz.y }, { x: 1000, y: Math.min(pz.y, 260) }, 700);
    await sleep(300);
    await step.hover();
    await sleep(300);
    await step.locator(".grow-btn").first().click();
    await sleep(900);
    for (const label of ["Why?", "Steps", "Break it down", "Two ways"]) {
      await hover(page, `.grow-shapes button:text-is("${label}")`, 400);
      await sleep(700);
    }
    await page.keyboard.press("Escape");
    await zoom(page, anchor, 5, 900);
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

  // A whole Wikipedia article, drawn as shapes, then section by section.
  async "10a-pages"(page) {
    await open(page, pageCanvas);
    const c = `.card-item[data-card-id="${pageCard}"]`;
    await bring(page, c, 330, 70, 10);
    await sleep(600);
    start();
    await sleep(1200);
    const at = async (sel) => page.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y } : null; }, sel);
    const here = await at(`${c} .facet-here`);
    if (here) await glide(page, here, { x: here.x, y: 160 }, 4000);
    await sleep(1200);
    const secs = await at(`${c} .page-sections`);
    if (secs) await glide(page, secs, { x: secs.x, y: 110 }, 2500);
    await sleep(1500);
    const second = await at(`${c} .page-section:nth-of-type(2)`);
    if (second) await glide(page, second, { x: second.x, y: 110 }, 4000);
    await sleep(3000);
  },

  // A call: words selected and said aloud; the answer; the piece grows where they pointed.
  async "10b-call"(page) {
    await open(page, pageCanvas);
    const c = `.card-item[data-card-id="${pageCard}"]`;
    const piece = `${c} [data-a="why-1"]`;
    // The call made while preparing grew this shape; its answer is replayed here (calling again
    // would grow a second one), and the shape shows when the answer lands.
    await page.addStyleTag({ content: `body:not(.answered) ${c} .grown { display: none !important; }` });
    await page.route("**/call", async (route) => {
      await sleep(1600);
      await route.fulfill({ json: { say: CALL.say, did: CALL.did } });
      await page.evaluate(() => document.body.classList.add("answered"));
    });
    const b = await box(page, piece);
    await glide(page, { x: b.x, y: b.y }, { x: 520, y: 330 }, 10);
    await sleep(800);
    start();
    await sleep(600);
    await hover(page, ".call-btn", 700);

    await page.click(".call-btn");
    await sleep(1200);

    // The words, selected as a person would: drag across them.
    const r = await page.locator(piece).first().evaluate((el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode()) && !n.data.includes("without turning"));
      if (!n) return null;
      const i = n.data.indexOf("without turning");
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + "without turning".length);
      const rs = range.getClientRects();
      const a = rs[0], z = rs[rs.length - 1];
      return { x0: a.left + 1, y: a.top + a.height / 2, x1: z.right - 1, y1: z.top + z.height / 2 };
    });
    if (r) {
      await page.mouse.move(r.x0 - 40, r.y + 30, { steps: 15 });
      await page.mouse.move(r.x0, r.y, { steps: 15 });
      await page.mouse.down();
      await page.mouse.move(r.x1, r.y1, { steps: 25 });
      await page.mouse.up();
    }
    await sleep(900);
    // Saying it: the recognizer hears it word by word.
    const words = CALL.text.split(" ");
    await page.evaluate(() => window.__rec?.onspeechstart?.());
    for (let i = 2; i <= words.length; i += 2) {
      await page.evaluate((t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: t } }, { isFinal: false })] }), words.slice(0, i).join(" "));
      await sleep(260);
    }
    await page.evaluate((t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: t } }, { isFinal: true })] }), CALL.text);
    await sleep(4200);
    const g = await box(page, `${c} .grown`);
    if (g) await glide(page, { x: g.x, y: g.y }, { x: 520, y: 260 }, 1800);
    await sleep(4000);
  },

  // An example notebook opens beside the canvas, credited, and runs.
  async "10c-notebook"(page) {
    await open(page, pageCanvas);
    const nbCard = `.card-item[data-card-id="${notebook}"]`;
    await bring(page, nbCard, 260, 120, 10);
    // Python warmed up off camera (it downloads once), then the panel closed again.
    await page.click(`${nbCard} .object-notebook button`);
    await page.waitForSelector(".nb-panel");
    await page.click(".nb-tools button:has-text('Run all')");
    for (let i = 0; i < 120; i++) {
      const busy = await page.evaluate(() => !!document.querySelector(".nb-out .spinner, .nb-status"));
      if (!busy && i > 3) break;
      await sleep(1000);
    }
    await page.click(".nb-tools button:has-text('✕')");
    await sleep(800);
    start();
    await sleep(700);
    await hover(page, `${nbCard} .object-notebook button`, 800);
    await sleep(500);
    await page.click(`${nbCard} .object-notebook button`);
    await sleep(2500);
    await hover(page, ".nb-tools button:has-text('Run all')", 600);
    await page.click(".nb-tools button:has-text('Run all')");
    await sleep(1500);
    // Down through the cells as they run.
    for (let i = 0; i < 9; i++) {
      await page.evaluate(() => document.querySelector(".nb-cells").scrollBy({ top: 260, behavior: "smooth" }));
      await sleep(1100);
    }
    await sleep(2000);
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
  // The opening keeps time by its own map of the narration; the others stretch every wait.
  PACE = id === "00-open" ? 1 : paceFor(id);
  page.setDefaultTimeout(20_000);
  log("recording", id, PACE === 1 ? "" : `at ${PACE.toFixed(2)}× the first timing`);
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
