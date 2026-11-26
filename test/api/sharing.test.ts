// F-SHARE: sharing a canvas with a colleague. The owner makes a link (to edit, or only to view);
// whoever opens it joins, even without an account; what they do is recorded as theirs; and when the
// owner comes back, they're shown what changed since they last looked, by whom, with what it took to
// undo it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv } from "../helpers/env.ts";
import { startServer, type TestServer } from "../helpers/server.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url, {
  LIBRARIAN_AUTH: "on",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
  SIGNUP_EMAILS: "owner@example.test",
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

describe("F-SHARE: sharing a canvas", () => {
  const owner = person();
  const ana = person();
  const viewer = person();
  const stranger = person();
  let cid = "";
  let mine = "";
  let editLink = "";

  before(async () => {
    assert.equal((await owner.send("POST", "/api/auth/sign-up/email", { email: "owner@example.test", password: "test-password-123", name: "Olive" })).status, 200);
    for (const p of [ana, viewer, stranger]) assert.equal((await p.send("POST", "/api/auth/sign-in/anonymous")).status, 200);
    cid = (await owner.send("POST", "/api/canvases", { name: "Yugoslavia" })).body.id;
    mine = (await owner.send("POST", `/api/canvases/${cid}/notes`, { text: "Start with the 1974 constitution", x: 0, y: 0 })).body.note.id;
    // The owner opens it once: from here on, what others do is new to them.
    assert.deepEqual((await owner.send("GET", `/api/canvases/${cid}/since`)).body.changes, []);
  });

  test("only the owner can make a link; it says what it lets you do", async () => {
    assert.equal((await stranger.send("POST", `/api/canvases/${cid}/links`, { role: "editor" })).status, 403);
    assert.equal((await owner.send("POST", `/api/canvases/${cid}/links`, { role: "admin" })).status, 400);
    const link = (await owner.send("POST", `/api/canvases/${cid}/links`, { role: "editor" })).body;
    assert.equal(link.role, "editor");
    editLink = link.token;
    const seen = (await owner.send("GET", `/api/canvases/${cid}`)).body;
    assert.equal(seen.role, "owner");
    assert.equal(seen.links.length, 1, "the owner sees their links");
    assert.equal(seen.seen, undefined, "nobody's read marks are sent");
  });

  test("a stranger can't open it; with the link, a visitor joins under the name they give", async () => {
    assert.equal((await stranger.send("GET", `/api/canvases/${cid}`)).status, 404);
    const joined = await ana.send("POST", `/api/join/${editLink}`, { name: "Ana" });
    assert.equal(joined.body.id, cid);
    const listed = (await ana.send("GET", "/api/canvases")).body.find((c: { id: string }) => c.id === cid);
    assert.equal(listed.role, "editor", "it's in their list, as an editor");
    assert.equal(listed.links, undefined, "an editor doesn't see the links");
    const members = (await owner.send("GET", `/api/canvases/${cid}`)).body.members;
    assert.deepEqual(members.map((m: { name: string; role: string }) => [m.name, m.role]), [["Ana", "editor"]]);
    assert.equal((await ana.send("POST", "/api/join/not-a-real-link", {})).status, 404);
  });

  test("an editor can change things but not delete, trash or share the canvas", async () => {
    assert.equal((await ana.send("POST", `/api/canvases/${cid}/notes`, { text: "And the 1981 Kosovo protests", x: 400, y: 0 })).status, 200);
    assert.equal((await ana.send("POST", `/api/canvases/${cid}/move`, { moves: [{ id: mine, x: 0, y: 300 }] })).status, 200);
    assert.equal((await ana.send("DELETE", `/api/canvases/${cid}`)).status, 403);
    assert.equal((await ana.send("PATCH", `/api/canvases/${cid}`, { trashed: true })).status, 403);
    assert.equal((await ana.send("POST", `/api/canvases/${cid}/links`, { role: "editor" })).status, 403);
  });

  test("the owner comes back to what changed, by whom, with where a moved thing was", async () => {
    const r = (await owner.send("GET", `/api/canvases/${cid}/since`)).body;
    const changes = r.changes as { what: string; by: { name: string }; label: string; id: string; before?: { x: number; y: number } }[];
    assert.deepEqual(changes.map((c) => [c.what, c.by.name]), [["added", "Ana"], ["moved", "Ana"]]);
    assert.match(changes[0].label, /Kosovo protests/);
    assert.equal(changes[1].id, mine);
    assert.deepEqual(changes[1].before, { x: 0, y: 0 }, "where it was, to put it back");
    // Their own changes are never news to them.
    assert.deepEqual((await ana.send("GET", `/api/canvases/${cid}/since`)).body.changes, []);
    // Once reviewed, they're not shown again.
    await owner.send("POST", `/api/canvases/${cid}/seen`, { seq: r.latest });
    assert.deepEqual((await owner.send("GET", `/api/canvases/${cid}/since`)).body.changes, []);
  });

  test("something added and then removed meanwhile isn't news", async () => {
    const n = (await ana.send("POST", `/api/canvases/${cid}/notes`, { text: "Oops", x: 800, y: 0 })).body.note.id;
    await ana.send("POST", `/api/canvases/${cid}/hide`, { ids: [n] });
    assert.deepEqual((await owner.send("GET", `/api/canvases/${cid}/since`)).body.changes, []);
  });

  test("a viewer can look but not change anything", async () => {
    const link = (await owner.send("POST", `/api/canvases/${cid}/links`, { role: "viewer" })).body.token;
    await viewer.send("POST", `/api/join/${link}`, { name: "Vic" });
    assert.equal((await viewer.send("GET", `/api/canvases/${cid}`)).body.role, "viewer");
    assert.equal((await viewer.send("POST", `/api/canvases/${cid}/notes`, { text: "hi", x: 0, y: 0 })).status, 403);
    assert.equal((await viewer.send("POST", `/api/canvases/${cid}/move`, { moves: [{ id: mine, x: 9, y: 9 }] })).status, 403);
  });

  test("a removed link stops working; whoever joined with it stays until taken off", async () => {
    assert.equal((await owner.send("DELETE", `/api/canvases/${cid}/links/${editLink}`)).status, 200);
    assert.equal((await stranger.send("POST", `/api/join/${editLink}`, {})).status, 404);
    assert.equal((await ana.send("GET", `/api/canvases/${cid}`)).status, 200);
    const anaId = (await ana.send("GET", "/api/me")).body.user.id;
    assert.equal((await owner.send("DELETE", `/api/canvases/${cid}/members/${anaId}`)).status, 200);
    assert.equal((await ana.send("GET", `/api/canvases/${cid}`)).status, 404);
  });
});
