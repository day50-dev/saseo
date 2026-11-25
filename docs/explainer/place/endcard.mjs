// The end card for "A place to think" (the other title cards are titles.mjs; not re-rendered here).
import { chromium } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const html = `<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1920px; height: 1080px; font-family: "Inter", "Segoe UI", system-ui, sans-serif; background: #f6f4ee; color: #1b2a3f;
    background-image: radial-gradient(#d9d4c7 1.5px, transparent 1.5px); background-size: 36px 36px; overflow: hidden; }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; text-align: center; }
  h1 { font-size: 110px; font-weight: 700; letter-spacing: -0.02em; }
  h2 { font-size: 58px; font-weight: 500; color: #3a4a63; }
  p { font-size: 46px; color: #2b5797; font-weight: 600; margin-top: 18px; }
</style>
<div class="center"><h1>Librarian</h1><h2>A place to think.</h2><p>librarian.9ol.es</p></div>`;
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.setContent(html);
await p.waitForTimeout(300);
await p.screenshot({ path: `${DIR}shots/d6-end.png` });
await b.close();
console.log("d6-end");
