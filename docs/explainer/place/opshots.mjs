import { chromium } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2, colorScheme: "light" });
const shots = [
  ["ham-top", "Hamiltonian_mechanics", null],
  ["ham-deriv", "Hamiltonian_mechanics", "From_Euler–Lagrange_equation_to_Hamilton's_equations"],
  ["legendre", "Legendre_transformation", null],
  ["phase", "Phase_space", null],
  ["lagrangian", "Lagrangian_mechanics", null],
  ["poisson", "Poisson_bracket", null],
];
for (const [name, page, anchor] of shots) {
  await p.goto(`https://en.wikipedia.org/wiki/${page}`, { waitUntil: "networkidle" });
  await p.evaluate(() => document.querySelectorAll("#siteNotice, #centralNotice, .cdx-message--notice, .vector-sticky-header").forEach((e) => e.remove()));
  if (anchor) await p.evaluate((a) => document.getElementById(a)?.scrollIntoView(), anchor);
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${DIR}op/${name}.png` });
  console.log(name);
}
await b.close();
