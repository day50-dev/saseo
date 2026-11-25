// Records the opener (op/op.html) as one clip under the first three narrations, timed by them.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const sec = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());
const LEAD = 0.45, TAIL = 0.65;
const script = JSON.parse(readFileSync(`${DIR}script-v3.json`, "utf8")).scenes;
const len = (id) => LEAD + sec(`${DIR}audio/${id}.wav`) + TAIL + (script.find((s) => s.id === id).hold ?? 0);
const L0 = len("d0-promise"), L1 = len("d1-noise"), L2 = len("d2-explore");
const r = (f) => sec(`${DIR}v3raw/${f}.wav`);
const T = {
  a: { bury: LEAD + r("d0-promise__00") + 0.9 - 0.15 },
  b: { start: L0, calm: L0 + LEAD + r("d1-noise__00") + 0.45 + r("d1-noise__01") + 0.45 - 0.08 },
  c: { start: L0 + L1, end: L0 + L1 + L2 },
};
console.log(JSON.stringify(T), "total", (L0 + L1 + L2).toFixed(2));
mkdirSync(`${DIR}clips`, { recursive: true });
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1110 }, recordVideo: { dir: `${DIR}raw-op`, size: { width: 1920, height: 1110 } } });
const p = await ctx.newPage();
const t0 = Date.now();
await p.goto(`file://${DIR}op/op.html#${encodeURIComponent(JSON.stringify(T))}`);
await p.waitForLoadState("load");
await p.waitForTimeout(1200);
const mark = (Date.now() - t0) / 1000;
await p.evaluate(() => window.__go());
await p.waitForTimeout((L0 + L1 + L2 + 1) * 1000);
const v = p.video();
await p.close();
await ctx.close();
renameSync(await v.path(), `${DIR}clips/op-raw.webm`);
execFileSync("python3", [`${DIR}retime.py`, `${DIR}clips/op-raw.webm`, `${DIR}clips/op.webm`, String(L0 + L1 + L2 + 0.5)], { stdio: "inherit" });
rmSync(`${DIR}raw-op`, { recursive: true, force: true });
const marks = JSON.parse(readFileSync(`${DIR}clips/marks.json`, "utf8"));
marks.op = 0; // retimed: the clip starts when the page started
writeFileSync(`${DIR}clips/marks.json`, JSON.stringify(marks, null, 2));
await b.close();
console.log("op mark", mark);
