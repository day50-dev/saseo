// Renders the explainer's title cards (opening, the problem, the end) to 1920x1080 PNGs.
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const DIR = process.env.WORK ?? new URL(".", import.meta.url).pathname; // where profiles, clips and shots go
mkdirSync(`${DIR}shots`, { recursive: true });
const slide = `data:image/png;base64,${readFileSync(process.env.SLIDE ?? "slide.png").toString("base64")}`;

const base = `
  <style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1920px; height: 1080px; font-family: "Inter", "Segoe UI", system-ui, sans-serif; background: #f6f4ee; color: #1b2a3f;
      background-image: radial-gradient(#d9d4c7 1.5px, transparent 1.5px); background-size: 36px 36px; overflow: hidden; }
    .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; text-align: center; }
    h1 { font-size: 96px; font-weight: 700; letter-spacing: -0.02em; }
    h2 { font-size: 54px; font-weight: 600; letter-spacing: -0.01em; max-width: 1400px; line-height: 1.2; margin: 0 auto; }
    p { font-size: 34px; color: #55627a; }
    .accent { color: #2b5797; }
  </style>`;

const cards = {
  // Opening: a dense research slide, and what it does to an outsider.
  "01-hook": `${base}
    <style>
      .slide { position: absolute; left: 50%; top: 50%; width: 1300px; transform: translate(-50%, -50%) rotate(-1.5deg);
        box-shadow: 0 30px 80px rgba(0,0,0,0.25); border-radius: 6px; filter: blur(1.2px) saturate(0.9); opacity: 0.85; }
      .veil { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(246,244,238,0.2), rgba(246,244,238,0.92) 70%); }
      .say { position: absolute; left: 0; right: 0; bottom: 120px; text-align: center; }
    </style>
    <img class="slide" src="${slide}">
    <div class="veil"></div>
    <div class="say"><h2>One unfamiliar word goes by,<br>and you're <span class="accent">lost</span>.</h2></div>`,

  // The problem: each definition is harder than the word it defines.
  "02-climb": `${base}
    <style>
      .ladder { position: absolute; left: 120px; bottom: 170px; display: flex; flex-direction: column-reverse; gap: 22px; }
      .rung { font-size: 38px; background: #fff; border: 2px solid #c9c2b2; border-radius: 12px; padding: 16px 26px; width: fit-content;
        box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
      .rung small { display: block; font-size: 22px; color: #8a8471; margin-bottom: 4px; }
      .r1 { margin-left: 0 } .r2 { margin-left: 90px } .r3 { margin-left: 180px } .r4 { margin-left: 270px; border-color: #b55; }
      .arrow { position: absolute; left: 40px; bottom: 150px; width: 900px; height: 600px; }
      .note { position: absolute; right: 100px; top: 190px; width: 640px; text-align: left; }
      .note h2 { font-size: 64px; }
      .note p { margin-top: 22px; }
    </style>
    <svg class="arrow" viewBox="0 0 900 600"><path d="M20 580 Q 300 520 520 330 T 880 20" fill="none" stroke="#b55" stroke-width="5" stroke-dasharray="14 12"/></svg>
    <div class="ladder">
      <div class="rung r1"><small>You looked up</small>Biot–Savart law</div>
      <div class="rung r2"><small>defined using</small>vector potential</div>
      <div class="rung r3"><small>which needs</small>Coulomb gauge</div>
      <div class="rung r4"><small>which needs</small>Helmholtz decomposition…</div>
    </div>
    <div class="note"><h2 style="margin:0">You <span style="color:#b55">climb</span>,<br>when you needed to <span class="accent">descend</span>.</h2><p>Every definition is harder than the word it explains.</p></div>`,

  "11-close": `${base}
    <div class="center">
      <h1>Librarian</h1>
      <h2 style="font-weight:500">Find your path to understanding.</h2>
      <p>Free · open · no account needed</p>
      <p style="font-size:44px;color:#2b5797;font-weight:600">librarian.9ol.es</p>
    </div>`,
};

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const [id, html] of Object.entries(cards)) {
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}shots/${id}.png` });
  console.log("rendered", id);
}
await browser.close();
