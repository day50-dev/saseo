// F-SHARE in the page: the owner makes a link from Share; a visitor opens it, gives a name and
// joins; what they change is theirs; the owner comes back to "since you were here", goes through
// the changes (each outlined on the canvas) and undoes one.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { startServer, type TestServer } from "../helpers/server.ts";

const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const SHOTS = process.env.SHARING_SHOTS; // a folder, to look at the steps
const llm = await fakeLlm();
const env = testEnv(llm.url, { LIBRARIAN_AUTH: "on", BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000", SIGNUP_EMAILS: "owner@example.test" });
let s: TestServer;
let browser: Browser;
before(async () => {
  s = await startServer(env);
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  await browser?.close();
  await s?.stop();
  await llm.close();
});

const shot = async (ctx: BrowserContext, name: string) => {
  if (SHOTS) await ctx.pages()[0].screenshot({ path: `${SHOTS}/${name}.png` });
};

describe("F-SHARE: sharing in the page", () => {
  test("share, join under a name, and come back to what they changed", async () => {
    // The owner, signed up, with a canvas holding one note.
    const owner = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const op = await owner.newPage();
    await op.goto(s.url);
    const req = (method: "post" | "get", path: string, data?: unknown) => op.request[method](`${s.url}${path}`, { data, headers: { origin: s.url } });
    assert.equal((await req("post", "/api/auth/sign-up/email", { email: "owner@example.test", password: "test-password-123", name: "Olive" })).status(), 200);
    const cid = (await (await req("post", "/api/canvases", { name: "Yugoslavia" })).json()).id;
    const mine = (await (await req("post", `/api/canvases/${cid}/notes`, { text: "Start with the 1974 constitution", x: 100, y: 100 })).json()).note.id;
    await op.goto(`${s.url}/c/${cid}`);
    await op.locator(".note-item").waitFor();

    // Share → a link that lets them edit.
    await op.getByRole("button", { name: /^Share/ }).click();
    await op.getByRole("button", { name: "Make a link" }).click();
    const url = await op.locator(".share-links input").inputValue();
    assert.match(url, /\/s\/[\w-]+$/);
    await shot(owner, "1-share");
    await op.keyboard.press("Escape");
    await op.locator(".panel-backdrop").click({ position: { x: 5, y: 5 } });

    // A visitor opens it: who shared what, then their name, then the canvas.
    const visitor = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const vp = await visitor.newPage();
    await vp.goto(url);
    await vp.getByText("Olive shared this canvas with you").waitFor();
    await shot(visitor, "2-join");
    await vp.getByLabel("Your name, as others will see it").fill("Ana");
    await vp.getByRole("button", { name: "Join and open it" }).click();
    await vp.waitForURL(`**/c/${cid}`);
    await vp.locator(".role-chip").getByText("Shared with you").waitFor();
    assert.equal(await vp.getByRole("button", { name: /^Share/ }).count(), 0, "only the owner shares");
    // They add a note and move the owner's.
    const vreq = (path: string, data: unknown) => vp.request.post(`${s.url}${path}`, { data, headers: { origin: s.url } });
    assert.equal((await vreq(`/api/canvases/${cid}/notes`, { text: "And the 1981 Kosovo protests", x: 600, y: 100 })).status(), 200);
    assert.equal((await vreq(`/api/canvases/${cid}/move`, { moves: [{ id: mine, x: 100, y: 500 }] })).status(), 200);
    await vp.reload();
    await vp.locator(".note-item").nth(1).waitFor();
    assert.equal(await vp.locator(".note-item .note-who").getByText("Olive", { exact: true }).count() + (await vp.locator(".note-item .note-who").getByText("You", { exact: true }).count()), 2, "notes say who left them");

    // The owner comes back.
    await op.reload();
    await op.locator(".changes-banner").getByText("Ana made 2 changes since you were last here").waitFor();
    assert.match(await op.locator(".note-item").filter({ hasText: "Kosovo" }).locator(".note-who").innerText(), /Ana/, "Ana's note says it's hers");
    await op.getByRole("button", { name: "Go through them" }).click();
    const rows = op.locator(".changes-panel li");
    assert.equal(await rows.count(), 2);
    assert.equal(await op.locator(".change-mark").count(), 2, "each change outlined on the canvas");
    await shot(owner, "3-review");
    // Undo the move: the note goes back where it was.
    await rows.filter({ hasText: "moved" }).getByRole("button", { name: "Undo" }).click();
    await until(async () => {
      const st = await (await req("get", `/api/canvases/${cid}`)).json();
      return st.items.find((i: { id: string; y: number }) => i.id === mine)?.y === 100;
    }, 5000, "the note back where it was");
    // Keep the other; then it's all been gone through.
    await rows.filter({ hasText: "added" }).getByRole("button", { name: "Keep" }).click();
    await op.getByText("You've been through everything.").waitFor();
    await op.getByRole("button", { name: "Done" }).click();
    await op.reload();
    await op.locator(".note-item").first().waitFor();
    await op.waitForTimeout(500);
    assert.equal(await op.locator(".changes-banner").count(), 0, "nothing new the next time");
    await owner.close();
    await visitor.close();
  });

  test("someone it's shared with to view sees no way to change it", async () => {
    const owner = await browser.newContext();
    const op = await owner.newPage();
    await op.goto(s.url);
    const req = (path: string, data?: unknown) => op.request.post(`${s.url}${path}`, { data, headers: { origin: s.url } });
    await req("/api/auth/sign-in/email", { email: "owner@example.test", password: "test-password-123" });
    const cid = (await (await req("/api/canvases", { name: "Look only" })).json()).id;
    await req(`/api/canvases/${cid}/notes`, { text: "A note", x: 0, y: 0 });
    const token = (await (await req(`/api/canvases/${cid}/links`, { role: "viewer" })).json()).token;
    const viewer = await browser.newContext();
    const vp = await viewer.newPage();
    await vp.goto(`${s.url}/s/${token}`);
    await vp.getByLabel("Your name, as others will see it").fill("Vic");
    await vp.getByRole("button", { name: "Join and open it" }).click();
    await vp.locator(".role-chip").getByText("View only").waitFor();
    assert.equal(await vp.getByRole("button", { name: /\+ Add/ }).count(), 0);
    assert.equal(await vp.getByRole("button", { name: "Undo" }).count(), 0);
    await owner.close();
    await viewer.close();
  });
});
