// Zotero: a reader links their library with Zotero's sign-in (OAuth 1.0a), sees what's in it, adds
// what the librarian finds (into a "Saseo" collection, without duplicates), and can disconnect.
// Against a fake Zotero that checks every signature.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv } from "../helpers/env.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import { oauthSignature } from "../../server/zotero.ts";

const APP = { key: "app-key", secret: "app-secret" };
const API_KEY = "reader-api-key";

// ---- A fake Zotero ----
const zot = {
  callback: "",
  items: [
    { key: "I1", data: { itemType: "journalArticle", title: "Attention Is All You Need", creators: [{ creatorType: "author", firstName: "Ashish", lastName: "Vaswani" }], date: "2017", url: "https://arxiv.org/abs/1706.03762" } },
    { key: "I2", data: { itemType: "book", title: "Gödel, Escher, Bach", creators: [{ creatorType: "author", name: "Hofstadter" }], date: "1979", DOI: "10.0000/geb" } },
    { key: "N1", data: { itemType: "note" } },
  ] as { key: string; data: Record<string, unknown> }[],
  collections: [] as { key: string; data: { name: string } }[],
  added: [] as Record<string, unknown>[],
  revoked: false,
  badSignatures: 0,
};

function authParams(req: IncomingMessage): Record<string, string> {
  const h = req.headers.authorization ?? "";
  const out: Record<string, string> = {};
  for (const m of h.matchAll(/(\w+)="([^"]*)"/g)) out[decodeURIComponent(m[1])] = decodeURIComponent(m[2]);
  return out;
}

function checkSigned(req: IncomingMessage, url: string, tokenSecret: string) {
  const p = authParams(req);
  const { oauth_signature, ...rest } = p;
  if (p.oauth_consumer_key !== APP.key || oauthSignature("POST", url, rest, APP.secret, tokenSecret) !== oauth_signature) {
    zot.badSignatures++;
    return null;
  }
  return p;
}

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => resolve(b));
  });

const zServer = createServer(async (req, res) => {
  const u = new URL(req.url!, `http://${req.headers.host}`);
  const send = (status: number, data: unknown, form = false) => {
    res.writeHead(status, { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" });
    res.end(form ? String(data) : JSON.stringify(data));
  };
  const base = `http://${req.headers.host}`;
  if (u.pathname === "/oauth/request") {
    const p = checkSigned(req, `${base}/oauth/request`, "");
    if (!p) return send(401, "bad signature", true);
    zot.callback = p.oauth_callback;
    return send(200, "oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true", true);
  }
  if (u.pathname === "/oauth/access") {
    const p = checkSigned(req, `${base}/oauth/access`, "req-secret");
    if (!p || p.oauth_token !== "req-token" || p.oauth_verifier !== "the-verifier") return send(401, "bad", true);
    return send(200, `oauth_token=${API_KEY}&oauth_token_secret=${API_KEY}&userID=42&username=reader`, true);
  }
  if (req.headers["zotero-api-key"] !== API_KEY) return send(403, "Forbidden");
  if (u.pathname === "/keys/current" && req.method === "DELETE") {
    zot.revoked = true;
    return send(204, "");
  }
  if (u.pathname === "/users/42/items/top") {
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    const all = [...zot.items, ...zot.added.map((d, i) => ({ key: `A${i}`, data: d }))];
    return send(200, all.filter((i) => !q || String(i.data.title ?? "").toLowerCase().includes(q)));
  }
  if (u.pathname === "/users/42/collections/top") return send(200, zot.collections);
  if (u.pathname === "/users/42/collections" && req.method === "POST") {
    const [c] = JSON.parse(await body(req)) as { name: string }[];
    zot.collections.push({ key: "COLL1", data: { name: c.name } });
    return send(200, { successful: { "0": { key: "COLL1" } }, failed: {} });
  }
  if (u.pathname === "/users/42/items" && req.method === "POST") {
    const [it] = JSON.parse(await body(req)) as Record<string, unknown>[];
    zot.added.push(it);
    return send(200, { successful: { "0": { key: `A${zot.added.length - 1}` } }, failed: {} });
  }
  send(404, { error: "not here" });
});
await new Promise<void>((r) => zServer.listen(0, "127.0.0.1", () => r()));
const zUrl = `http://127.0.0.1:${(zServer.address() as AddressInfo).port}`;

const llm = await fakeLlm();
let s: TestServer;
before(async () => {
  s = await startServer(
    testEnv(llm.url, { ZOTERO_OAUTH_URL: `${zUrl}/oauth`, ZOTERO_API_URL: zUrl, ZOTERO_CLIENT_KEY: APP.key, ZOTERO_CLIENT_SECRET: APP.secret }),
  );
});
after(async () => {
  await s?.stop();
  await llm.close();
  zServer.close();
});

const noFollow = (p: string) => fetch(`${s.url}${p}`, { redirect: "manual" });

describe("F-ZOTERO: a reader's Zotero library", () => {
  test("the page is told Zotero is on offer, not yet linked", async () => {
    const me = await s.api("GET", "/api/me");
    assert.deepEqual(me.body.zotero, { linked: null });
  });

  test("connecting goes to Zotero's sign-in, signed, asking to read and write the library", async () => {
    const r = await noFollow("/api/zotero/connect?back=/c/abc");
    assert.equal(r.status, 302);
    const to = new URL(r.headers.get("location")!);
    assert.equal(`${to.origin}${to.pathname}`, `${zUrl}/oauth/authorize`);
    assert.equal(to.searchParams.get("oauth_token"), "req-token");
    assert.equal(to.searchParams.get("library_access"), "1");
    assert.equal(to.searchParams.get("write_access"), "1");
    assert.equal(zot.callback, `${s.url}/api/zotero/callback`);
    assert.equal(zot.badSignatures, 0);
  });

  test("back from Zotero, the library is linked and the reader returns where they were", async () => {
    const r = await noFollow("/api/zotero/callback?oauth_token=req-token&oauth_verifier=the-verifier");
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/c/abc?zotero=linked");
    assert.equal(zot.badSignatures, 0);
    assert.deepEqual((await s.api("GET", "/api/me")).body.zotero, { linked: "reader" });
  });

  test("the same sign-in can't be finished twice", async () => {
    const r = await noFollow("/api/zotero/callback?oauth_token=req-token&oauth_verifier=the-verifier");
    assert.match(decodeURIComponent(r.headers.get("location")!), /\/zotero\?zotero=.*expired/);
  });

  test("the library lists its papers and books, not notes, with a link to each", async () => {
    const { body } = await s.api("GET", "/api/zotero/items");
    assert.deepEqual(
      body.items.map((i: { title: string; url: string; authors: string[]; year: string }) => [i.title, i.url, i.authors.join(), i.year]),
      [
        ["Attention Is All You Need", "https://arxiv.org/abs/1706.03762", "Ashish Vaswani", "2017"],
        ["Gödel, Escher, Bach", "https://doi.org/10.0000/geb", "Hofstadter", "1979"],
      ],
    );
    const found = await s.api("GET", "/api/zotero/items?q=attention");
    assert.equal(found.body.items.length, 1);
  });

  test("an arXiv paper is added as a preprint, in a new Saseo collection", async () => {
    const r = await s.api("POST", "/api/zotero/items", {
      url: "https://arxiv.org/abs/2401.00001",
      title: "A New Paper",
      authors: ["Ada Lovelace", "Plato"],
      date: "2024-01-01",
      abstract: "We show things.",
      arxiv: "2401.00001",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.already, false);
    assert.deepEqual(zot.collections.map((c) => c.data.name), ["Saseo"]);
    const it = zot.added[0];
    assert.equal(it.itemType, "preprint");
    assert.equal(it.archiveID, "arXiv:2401.00001");
    assert.deepEqual(it.collections, ["COLL1"]);
    assert.deepEqual(it.creators, [
      { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
      { creatorType: "author", name: "Plato" },
    ]);
  });

  test("a page is added as a web page, into the same collection", async () => {
    const r = await s.api("POST", "/api/zotero/items", { url: "https://en.wikipedia.org/wiki/Fresco", title: "Fresco - Wikipedia" });
    assert.equal(r.body.already, false);
    const it = zot.added[1];
    assert.equal(it.itemType, "webpage");
    assert.equal(it.websiteTitle, "en.wikipedia.org");
    assert.deepEqual(it.collections, ["COLL1"]);
    assert.equal(zot.collections.length, 1);
  });

  test("something already in the library isn't added twice", async () => {
    const r = await s.api("POST", "/api/zotero/items", { url: "http://arxiv.org/abs/1706.03762/", title: "Attention is all you need" });
    assert.equal(r.body.already, true);
    assert.equal(zot.added.length, 2);
  });

  test("only a web address can be added", async () => {
    const r = await s.api("POST", "/api/zotero/items", { url: "javascript:alert(1)", title: "x" });
    assert.equal(r.status, 400);
  });

  test("disconnecting deletes Saseo's key at Zotero and forgets the link", async () => {
    const r = await s.api("DELETE", "/api/zotero");
    assert.equal(r.status, 200);
    assert.equal(zot.revoked, true);
    assert.deepEqual((await s.api("GET", "/api/me")).body.zotero, { linked: null });
    assert.equal((await s.api("GET", "/api/zotero/items")).status, 400);
  });

  test("turning Zotero down on its page comes back with a note", async () => {
    const r = await noFollow("/api/zotero/callback?oauth_token=req-token");
    assert.match(decodeURIComponent(r.headers.get("location")!), /zotero=Zotero wasn't connected/);
  });
});
