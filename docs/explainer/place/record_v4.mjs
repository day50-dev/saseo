// Records "A place to think" (fourth cut): the call, the space and the close, on the Hamiltonian demo canvas.
// Each page carries a clock strip under the picture (window.__tcgo() starts it), so the clip can be
// retimed to the page's own clock afterwards (retime.py): screen recording falls behind when busy.
// Usage: PLAYWRIGHT_BROWSERS_PATH=$PWD/pw node record_v3.mjs [scene ...]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const DIR = new URL(".", import.meta.url).pathname;
const SITE = "https://librarian.9ol.es";
const ids = JSON.parse(readFileSync(`${DIR}canvases.json`, "utf8"));
const CALL = JSON.parse(readFileSync(`${DIR}call4.json`, "utf8")).turns;
const S = JSON.parse(readFileSync(`${DIR}call4-schedule.json`, "utf8"));
const SCRIPT = JSON.parse(readFileSync(`${DIR}script-v4.json`, "utf8")).scenes;
const W = 1920, H = 1080, STRIP = 30, LEAD = 0.45, TAIL = 0.65;
const sec = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
const lengthOf = (id) => LEAD + sec(`${DIR}audio/${id}.wav`) + TAIL + (SCRIPT.find((s) => s.id === id).hold ?? 0);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });

async function newScene() {
  const ctx = await browser.newContext({
    storageState: `${DIR}state.json`,
    viewport: { width: W, height: H + STRIP },
    recordVideo: { dir: `${DIR}raw-v4`, size: { width: W, height: H + STRIP } },
  });
  await ctx.addInitScript(() => {
    // Headless Chrome has no speech: the scene drives the recognizer, and the voice is silent here.
    window.webkitSpeechRecognition = window.SpeechRecognition = class {
      constructor() {
        window.__rec = this;
      }
      start() {}
      stop() {}
      abort() {}
    };
    if (window.speechSynthesis) speechSynthesis.speak = (u) => setTimeout(() => u.onend?.(), 2500);
    try {
      localStorage.setItem("librarian.callWait", "0.5");
    } catch {}
    // The clock strip, under the picture; the app is kept to the picture above it.
    const put = () => {
      if (!document.body || document.getElementById("tc")) return;
      const st = document.createElement("style");
      st.textContent = `#tc{position:fixed;left:0;top:${1080}px;height:30px;width:1920px;background:#000;display:flex;z-index:2147483647}
        #tc i{width:24px;height:30px;background:#000}#tc i.on{background:#fff}
        .canvas-page,.nb-panel,.goals-panel,.panel-backdrop{bottom:30px!important}
        html,body{max-height:1080px}`;
      document.head.appendChild(st);
      const tc = document.createElement("div");
      tc.id = "tc";
      tc.innerHTML = "<i></i>".repeat(17);
      document.body.appendChild(tc);
      const cells = [...tc.children];
      const tick = () => {
        const g = Number(sessionStorage.getItem("tcgo") || 0);
        if (g) {
          const v = Math.floor((Date.now() - g) / 10);
          cells[0].classList.add("on");
          for (let i = 0; i < 16; i++) cells[i + 1].classList.toggle("on", Boolean((v >> (15 - i)) & 1));
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    document.addEventListener("DOMContentLoaded", put);
    window.__tcgo = () => sessionStorage.setItem("tcgo", String(Date.now()));
  });
  return ctx;
}

const zoomBtn = (page) => page.evaluate(() => Number([...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()))?.textContent.trim().replace("%", "")));

/** Opens the demo canvas at a zoom, clean. */
async function open(page, zoomTo = 120) {
  await page.goto(`${SITE}/c/${ids.ham}`);
  await page.waitForSelector(".stage");
  await page.locator(".card-item").first().waitFor();
  await sleep(2500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((b) => /^\d+%$/.test(b.textContent.trim()));
    if (b && b.textContent.trim() !== "100%") b.click();
  });
  await sleep(500);
  for (let i = 0; i < 12 && (await zoomBtn(page)) < zoomTo; i++) {
    await page.mouse.move(W / 2, H / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -40);
    await page.keyboard.up("Control");
    await sleep(120);
  }
  await page.addStyleTag({
    content: `.start-open, .save-link, .toolbar .hint { display: none !important; }
      .card-item .chat { display: none !important; }
      .card-item[data-card-id="${ids.hamVideos}"] .asked { display: none !important; }`,
  });
}

/**
 * Glides the view so a screen point moves to another, over `ms`: animated inside the page on its
 * own clock (one call, not one per step, which falls behind when the page is busy).
 */
async function glide(page, from, to, ms) {
  await page.evaluate(
    ([dx, dy, ms]) =>
      new Promise((done) => {
        const stage = document.querySelector(".stage");
        const t0 = performance.now();
        let sent = 0;
        const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
        const step = () => {
          const t = Math.min(1, (performance.now() - t0) / ms);
          const want = ease(t);
          const d = want - sent;
          sent = want;
          stage.dispatchEvent(new WheelEvent("wheel", { deltaX: dx * d, deltaY: dy * d, bubbles: true, cancelable: true, clientX: 960, clientY: 540 }));
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    [from.x - to.x, from.y - to.y, Math.max(1, ms)],
  );
}
const box = (page, sel) => page.locator(sel).first().boundingBox();
async function bring(page, sel, tx, ty, ms) {
  const b = await box(page, sel);
  if (!b) throw new Error(`not found: ${sel}`);
  await glide(page, { x: b.x, y: b.y }, { x: tx, y: ty }, ms);
}
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

/** A drawn cursor (headless Chrome draws none) that glides; the real pointer follows for hovers. */
async function addCursor(page) {
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = `#fx-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483646;pointer-events:none;transition:transform var(--t,0ms) cubic-bezier(.45,.05,.35,1)}`;
    document.head.appendChild(st);
    const c = document.createElement("div");
    c.id = "fx-cursor";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2 L3 20 L8 15.5 L11.5 23 L14.5 21.6 L11 14.3 L18 14.3 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
  });
}
async function cursor(page, x, y, ms = 600) {
  await page.evaluate(([x, y, ms]) => {
    const c = document.getElementById("fx-cursor");
    c.style.setProperty("--t", `${ms}ms`);
    c.style.transform = `translate(${x}px, ${y}px)`;
  }, [x, y, ms]);
  // The drawn cursor glides; the real one (for hover outlines and "pointing at") lands when it does.
  await sleep(ms);
  await page.mouse.move(x, y);
}
async function cursorTo(page, sel, ms = 700, dx = 0.5, dy = 0.5) {
  const b = await box(page, sel);
  if (b) await cursor(page, b.x + Math.min(b.width * dx, 160), b.y + b.height * dy, ms);
}

/** Steps the zoom (Ctrl+wheel at a point, which stays put) until the toolbar reads about `pct`. */
async function zoomTo(page, at, pct, ms = 700) {
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 20; i++) {
    const z = await zoomBtn(page);
    if (Math.abs(z - pct) < 6) break;
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, z < pct ? -40 : 40);
    await page.keyboard.up("Control");
    await sleep(ms / 8);
  }
}
/** Glides an element's centre to a screen point. */
async function centre(page, sel, tx = 960, ty = 540, ms = 900) {
  const b = await box(page, sel);
  if (b) await glide(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: tx, y: ty }, ms);
}

const scenes = {
  // The call, from an empty page: the narrator introduces it, the button, then four questions.
  // Only what this call makes is shown: the question, its card, the steps grown on it, the set
  // and the diagram. Replayed from the real call (call4.json) in time with call4-schedule.json.
  async "d3-call"(page, go) {
    const card = (id) => `.card-item[data-card-id="${id}"]`;
    const Q = card(ids.hamQ), MC = card(ids.hamCard), SET = card(ids.hamSet), DG = card(ids.hamDiagram);
    const keep = [ids.hamQ, ids.hamCard, ids.hamSet, ids.hamDiagram];
    await open(page, 100);
    await page.addStyleTag({
      content: `
        .card-item${keep.map((k) => `:not([data-card-id="${k}"])`).join("")}, .video-item, .note-item,
        path[data-card]${keep.map((k) => `:not([data-card="${k}"])`).join("")} { display: none !important; }
        ${Q}, ${MC}, path[data-card="${ids.hamCard}"] { transition: opacity 500ms, clip-path 3.4s cubic-bezier(.3,.1,.3,1); }
        body:not(.fx-q) ${Q} { opacity: 0; }
        body:not(.fx-build) ${MC}, body:not(.fx-build) path[data-card="${ids.hamCard}"] { opacity: 0; clip-path: inset(0 0 100% 0); }
        body.fx-build ${MC} { clip-path: inset(0 0 0 0); }
        body:not(.fx-g1) ${MC} .grown-then { display: none !important; }
        body:not(.fx-set) ${SET}, body:not(.fx-set) path[data-card="${ids.hamSet}"] { display: none !important; }
        body:not(.fx-dg) ${DG}, body:not(.fx-dg) path[data-card="${ids.hamDiagram}"] { display: none !important; }
        ${SET}, ${DG} { transition: opacity 600ms, transform 600ms; }
        body.fx-set-pre ${SET}, body.fx-dg-pre ${DG} { opacity: 0; transform: translateY(16px); }
        ${DG} .object-diagram img { transition: clip-path 2.0s ease-in-out; }
        body:not(.fx-draw) ${DG} .object-diagram img { clip-path: inset(0 0 100% 0); }
        body.fx-draw ${DG} .object-diagram img { clip-path: inset(0 0 0 0); }
      `,
    });
    await addCursor(page);
    // The question's place near the top, the card's place under it, both empty for now.
    const qb = await box(page, Q), mb = await box(page, MC);
    const l = Math.min(qb.x, mb.x), r = Math.max(qb.x + qb.width, mb.x + mb.width), t = Math.min(qb.y, mb.y);
    await glide(page, { x: (l + r) / 2, y: t }, { x: 960, y: 120 }, 10);
    await cursor(page, 1500, 700, 0);
    await sleep(800);
    const T0 = Date.now() + LEAD * 1000;
    // The replies, in order: a first answer, then the real call's three (the first cut short).
    const replies = [
      { say: "Let me put a card together for that." },
      { say: "Sure, let me break that down on the card.", did: CALL[0].reply.did },
      CALL[1].reply,
      CALL[2].reply,
    ];
    let turn = 0;
    await page.route("**/call", async (route) => {
      const i = Math.min(turn++, 3);
      const wait = T0 + S[`a${i}`].start * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      await route.fulfill({ json: { say: replies[i].say, did: replies[i].did } });
    });
    go();
    const at = async (t) => {
      const w = T0 + t * 1000 - Date.now();
      if (w > 0) await sleep(w);
    };
    const body = (c, on = true) => page.evaluate(([c, on]) => document.body.classList.toggle(c, on), [c, on]);
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
    const piece = (k) => `${MC} [data-a="${k}"]`;
    const park = () => cursor(page, 1840, 1000, 700); // over empty canvas: pointing at nothing
    // "You call a librarian": the button.
    await at(S.n1.start + 0.2);
    await cursorTo(page, ".call-btn", 800);
    await at(S.n1.start + 1.6);
    await page.click(".call-btn");
    await park();
    // Q0: the first question, from nothing. It's written down, and the card builds under it.
    await sayIt("What is a Hamiltonian, and why is it the energy?", S.q0.start, S.q0.end);
    await at(S.q0.end + 0.3);
    await body("fx-q");
    await at(S.a0.start + 0.7);
    await body("fx-build");
    // Q1: "Can you expand on this?" pointing at Hamilton's equations.
    await at(S.q1.start - 2.6);
    await centre(page, piece("here-3"), 960, 420, 900);
    await zoomTo(page, { x: 960, y: 420 }, 135, 600);
    await centre(page, piece("here-3"), 960, 420, 400);
    await cursorTo(page, piece("here-3"), 600, 0.3);
    await sayIt(CALL[0].text, S.q1.start, S.q1.end);
    await at(S.a1.start + 0.9);
    await body("fx-g1");
    await sleep(250);
    // Close enough to read the steps it added.
    await centre(page, `${MC} .grown-then`, 960, 560, 900);
    await zoomTo(page, { x: 960, y: 560 }, 175, 700);
    await park();
    // Q2: examples, not pointing at anything; the set comes in and fills the view.
    await at(S.q2.start - 0.4);
    await sayIt(CALL[1].text, S.q2.start, S.q2.end);
    await at(S.a2.start + 1.6);
    await body("fx-set-pre");
    await body("fx-set");
    await sleep(60);
    await zoomTo(page, { x: 960, y: 540 }, 110, 600);
    await centre(page, SET, 960, 560, 1300);
    await body("fx-set-pre", false);
    await sleep(300);
    const sb = await box(page, SET);
    if (sb && sb.height > 980) await zoomTo(page, { x: 960, y: 540 }, Math.round(((110 * 980) / sb.height) / 10) * 10, 400);
    await centre(page, SET, 960, 545, 500);
    // Q3: the diagram; the shot ends as it finishes drawing.
    await at(S.q3.start - 0.3);
    await sayIt(CALL[2].text, S.q3.start, S.q3.end);
    await at(S.a3.start + 0.3);
    await body("fx-dg-pre");
    await body("fx-dg");
    await sleep(60);
    await centre(page, DG, 960, 545, 1100);
    await body("fx-dg-pre", false);
    await sleep(200);
    await body("fx-draw");
    await at(S.a3.end + 2.2);
  },

  // The space: the whole page, drifting along what it connects to the lecture playing; then the
  // list of pages, and this one opened again, as it was.
  async "d4-space"(page, go) {
    const len = lengthOf("d4-space");
    const first = LEAD + sec(`${DIR}v4fast/d4-space__00.wav`);
    await open(page, 60);
    await addCursor(page);
    await page.locator(".video-own").waitFor({ timeout: 30000 });
    await page.evaluate(async () => {
      const v = document.querySelector(".video-own");
      v.muted = true;
      v.currentTime = 75;
      await v.play();
    });
    await sleep(1500);
    await centre(page, `.card-item[data-card-id="${ids.hamSet}"]`, 760, 540, 10);
    await cursor(page, 1840, 1000, 0);
    await sleep(800);
    const T0 = Date.now() + LEAD * 1000;
    go();
    const at = async (t) => {
      const w = T0 + t * 1000 - Date.now();
      if (w > 0) await sleep(w);
    };
    // "the page fills up with what you've found and how it all connects": one slow drift.
    await at(0.2);
    await centre(page, ".video-item", 1200, 520, (first - 0.7) * 1000);
    // "Come back next week, and it's exactly where you left it."
    await at(first - 0.4);
    await page.goto(`${SITE}/`);
    await page.locator(`a[href="/c/${ids.ham}"]`).first().waitFor();
    await addCursor(page);
    await page.addStyleTag({ content: ".save-link { display: none !important; }" });
    await cursor(page, 900, 700, 0);
    await cursorTo(page, `a[href="/c/${ids.ham}"]`, 700);
    await at(first + 1.9);
    await page.click(`a[href="/c/${ids.ham}"]`);
    await page.waitForSelector(".card-item");
    await page.addStyleTag({ content: `.start-open, .save-link, .toolbar .hint { display: none !important; } .card-item .chat { display: none !important; }` });
    await at(len - LEAD + 0.2);
  },

  // The close: everything, zooming slowly out to the whole canvas.
  async "d5-close"(page, go) {
    const len = lengthOf("d5-close");
    await open(page, 60);
    await bring(page, `.card-item[data-card-id="${ids.hamCard}"]`, 300, 120, 10);
    await sleep(800);
    const T0 = Date.now() + LEAD * 1000;
    go();
    const at = async (t) => {
      const w = T0 + t * 1000 - Date.now();
      if (w > 0) await sleep(w);
    };
    await at(0.4);
    const STEPS = Math.min(15, Math.floor((len - 1.5) / 0.9));
    for (let i = 0; i < STEPS; i++) {
      await zoom(page, { x: 960, y: 540 }, 1, 40);
      const c = await page.evaluate(() => {
        const rs = [...document.querySelectorAll(".card-item, .video-item, .note-item")].map((e) => e.getBoundingClientRect());
        const l = Math.min(...rs.map((r) => r.left)), r = Math.max(...rs.map((r) => r.right));
        const t = Math.min(...rs.map((r) => r.top)), b = Math.max(...rs.map((r) => r.bottom));
        return { x: (l + r) / 2, y: (t + b) / 2 };
      });
      const k = 1 / (STEPS - i);
      await glide(page, c, { x: c.x + (960 - c.x) * k, y: c.y + (575 - c.y) * k }, 750);
      await at(0.4 + (i + 1) * 0.9);
    }
    await at(len - LEAD + 0.2);
  },
};

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);
mkdirSync(`${DIR}clips`, { recursive: true });
const marks = JSON.parse(readFileSync(`${DIR}clips/marks.json`, "utf8"));
for (const id of want) {
  const ctx = await newScene();
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  log("recording", id);
  try {
    await scenes[id](page, () => page.evaluate(() => window.__tcgo()));
  } catch (err) {
    log(id, "failed:", err.message);
  }
  const video = page.video();
  await page.close();
  await ctx.close();
  renameSync(await video.path(), `${DIR}clips/${id}-raw.webm`);
  execFileSync("python3", [`${DIR}retime.py`, `${DIR}clips/${id}-raw.webm`, `${DIR}clips/${id}.webm`, String(lengthOf(id) + 0.5)], { stdio: "inherit" });
  marks[id] = 0;
  log("saved", id);
}
writeFileSync(`${DIR}clips/marks.json`, JSON.stringify(marks, null, 2));
rmSync(`${DIR}raw-v4`, { recursive: true, force: true });
await browser.close();
