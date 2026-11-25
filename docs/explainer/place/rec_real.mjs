// Screen recordings of the real attention economy, logged out: swiping through short videos, and a
// page of clickbait. Raw material for the noise montage.
import { renameSync, rmSync } from "node:fs";
import { chromium } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const takes = {
  async "yt-shorts"(p) {
    await p.goto("https://www.youtube.com/shorts", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(5000);
    for (let i = 0; i < 9; i++) { await p.keyboard.press("ArrowDown"); await p.waitForTimeout(1700); }
  },
  async "yt-search"(p) {
    await p.goto("https://www.youtube.com/results?search_query=you+won%27t+believe", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(5000);
    for (let i = 0; i < 30; i++) { await p.mouse.wheel(0, 260); await p.waitForTimeout(450); }
  },
  async tiktok(p) {
    await p.goto("https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(6000);
    const skip = p.getByText("Skip", { exact: true });
    if (await skip.count()) await skip.first().click().catch(() => {});
    await p.waitForTimeout(1500);
    for (let i = 0; i < 9; i++) { await p.keyboard.press("ArrowDown"); await p.waitForTimeout(1700); }
  },
  async insta(p) {
    await p.goto("https://www.instagram.com/reels/", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(6000);
    for (let i = 0; i < 9; i++) { await p.keyboard.press("ArrowDown"); await p.waitForTimeout(1700); }
  },
};
for (const [name, run] of Object.entries(takes)) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US", userAgent: UA, recordVideo: { dir: `${DIR}raw-real`, size: { width: 1920, height: 1080 } } });
  const p = await ctx.newPage();
  const t0 = Date.now();
  try { await run(p); } catch (e) { console.log(name, "failed:", e.message.slice(0, 120)); }
  const v = p.video();
  await p.close();
  await ctx.close();
  renameSync(await v.path(), `${DIR}real/${name}.webm`);
  console.log(name, ((Date.now() - t0) / 1000).toFixed(1), "s");
}
rmSync(`${DIR}raw-real`, { recursive: true, force: true });
await b.close();
