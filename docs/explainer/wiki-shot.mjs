// The climb, shown rather than told: Wikipedia's "Bialgebra" page as anyone would see it, a classic
// case of an abstract algebra term defined with more abstract algebra. Saved as the climb shot.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const DIR = process.env.WORK ?? new URL(".", import.meta.url).pathname;
mkdirSync(`${DIR}shots`, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
// 1280×720 drawn at 1.5×: a full-size frame whose text reads at video size.
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: "light" });
await page.goto("https://en.wikipedia.org/wiki/Bialgebra", { waitUntil: "networkidle" });
// Only the donation and site banners go; the page is otherwise as it is.
await page.evaluate(() => document.querySelectorAll("#siteNotice, #centralNotice, .cdx-message--notice").forEach((e) => e.remove()));
await page.screenshot({ path: `${DIR}shots/02-climb.png` });
console.log("02-climb.png");
await browser.close();
