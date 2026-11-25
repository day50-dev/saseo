// F-HOST: hosting it for other people. Visitors use it without signing in; signing in keeps their
// canvases (and brings along what they made before); each person sees only their own; only admins
// see or change the shared models and searchers; sign-ups can be limited to a list.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv } from "../helpers/env.ts";
import { startServer, type TestServer } from "../helpers/server.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url, {
  LIBRARIAN_AUTH: "on",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
  ADMIN_EMAILS: "admin@example.test",
  SIGNUP_EMAILS: "admin@example.test,reader@example.test,visitor@example.test",
});
let s: TestServer;
before(async () => (s = await startServer(env)));
after(async () => {
  await s?.stop();
  await llm.close();
});

/** A browser's worth of cookies. */
function person() {
  const jar = new Map<string, string>();
  const send = async (method: string, path: string, json?: unknown) => {
    const r = await fetch(`${s.url}${path}`, {
      method,
      headers: {
        origin: s.url,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body };
  };
  return { send };
}
const password = "test-password-123";

describe("F-HOST: accounts", () => {
  const admin = person();
  const reader = person();
  let readerCanvas = "";

  test("nobody signed in: the app says accounts are on, and the API asks for a sign-in", async () => {
    const nobody = person();
    const me = (await nobody.send("GET", "/api/me")).body;
    assert.equal(me.accounts, true);
    assert.equal(me.user, null);
    assert.equal((await nobody.send("GET", "/api/canvases")).status, 401);
  });

  test("a visitor can use it straight away, and keeps what they made when they sign up", async () => {
    const visitor = person();
    assert.equal((await visitor.send("POST", "/api/auth/sign-in/anonymous")).status, 200);
    assert.equal((await visitor.send("GET", "/api/me")).body.user.anonymous, true);
    const made = (await visitor.send("POST", "/api/canvases", { name: "Before signing up" })).body;
    const up = await visitor.send("POST", "/api/auth/sign-up/email", { email: "visitor@example.test", password, name: "Visitor" });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const me = (await visitor.send("GET", "/api/me")).body.user;
    assert.equal(me.anonymous, false);
    const mine = (await visitor.send("GET", "/api/canvases")).body as { id: string }[];
    assert.ok(mine.some((c) => c.id === made.id), "the canvas came along");
  });

  test("each person sees only their own canvases", async () => {
    assert.equal((await admin.send("POST", "/api/auth/sign-up/email", { email: "admin@example.test", password, name: "Admin" })).status, 200);
    assert.equal((await reader.send("POST", "/api/auth/sign-up/email", { email: "reader@example.test", password, name: "Reader" })).status, 200);
    readerCanvas = (await reader.send("POST", "/api/canvases", { name: "Mine" })).body.id;
    assert.equal((await reader.send("GET", `/api/canvases/${readerCanvas}`)).status, 200);
    assert.equal((await admin.send("GET", `/api/canvases/${readerCanvas}`)).status, 404);
    assert.ok(!((await admin.send("GET", "/api/canvases")).body as { id: string }[]).some((c) => c.id === readerCanvas));
    assert.equal((await admin.send("POST", `/api/canvases/${readerCanvas}/hide`, { ids: [] })).status, 404);
    assert.equal((await admin.send("DELETE", `/api/canvases/${readerCanvas}`)).status, 404);
  });

  test("only admins see or change the models and searchers", async () => {
    assert.equal((await admin.send("GET", "/api/me")).body.user.admin, true);
    assert.equal((await reader.send("GET", "/api/me")).body.user.admin, false);
    assert.equal((await reader.send("GET", "/api/config")).status, 403);
    assert.equal((await reader.send("PUT", "/api/config", { llm: { model: "x" } })).status, 403);
    assert.equal((await reader.send("POST", "/api/test/llm")).status, 403);
    assert.equal((await admin.send("GET", "/api/config")).status, 200);
  });

  test("sign-ups can be limited to a list", async () => {
    const stranger = person();
    const r = await stranger.send("POST", "/api/auth/sign-up/email", { email: "stranger@example.test", password, name: "Stranger" });
    assert.notEqual(r.status, 200);
    assert.match(JSON.stringify(r.body), /closed/);
  });

  test("signing in again finds the same canvases", async () => {
    const again = person();
    assert.equal((await again.send("POST", "/api/auth/sign-in/email", { email: "reader@example.test", password })).status, 200);
    assert.ok(((await again.send("GET", "/api/canvases")).body as { id: string }[]).some((c) => c.id === readerCanvas));
  });
});
