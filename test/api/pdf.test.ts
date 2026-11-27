// F-PDF: a linked PDF is read in one place, a page at a time; a page worth working on is taken out
// onto the canvas as its own page (with its words), the way stopping a video takes out its frame.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv } from "../helpers/env.ts";
import { makePdf } from "../helpers/pdf.ts";
import { seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";

const pdf = makePdf(["The first page", "Gauss on the second page", "The third page"]);
const files = createServer((req, res) => {
  if (req.url === "/paper.pdf") {
    res.writeHead(200, { "content-type": "application/pdf" });
    return res.end(pdf);
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => files.listen(0, "127.0.0.1", () => r()));
const pdfUrl = `http://127.0.0.1:${(files.address() as AddressInfo).port}/paper.pdf`;

const llm = await fakeLlm();
const env = testEnv(llm.url);
seed(env.LIBRARIAN_DATA, [{ id: "pdfs0001", name: "PDFs", items: [] }]);
let s: TestServer;
before(async () => (s = await startServer(env)));
after(async () => {
  await s?.stop();
  await llm.close();
  files.close();
});

describe("F-PDF: reading a PDF and taking pages out", () => {
  let docId = "";

  test("a linked PDF is one reader, not a page each", async () => {
    const r = await s.api("POST", "/api/canvases/pdfs0001/sources", { input: pdfUrl, x: 0, y: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.images, undefined);
    const doc = r.body.image;
    assert.equal(doc.doc.pages, 3);
    assert.equal(doc.doc.url, pdfUrl);
    assert.ok(doc.doc.file && doc.asset, "the whole PDF is kept, and its first page drawn");
    const kept = await fetch(`${s.url}/api/assets/${doc.doc.file}`);
    assert.equal(Buffer.from(await kept.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    const items = (await s.api("GET", "/api/canvases/pdfs0001")).body.items;
    assert.equal(items.length, 1);
    docId = doc.id;
  });

  test("a page taken out is its own page, with its words, pointing back to the PDF", async () => {
    const r = await s.api("POST", `/api/canvases/pdfs0001/docs/${docId}/pages`, { page: 2, x: 700, y: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body.image;
    assert.equal(p.pdf.page, 2);
    assert.equal(p.pdf.pages, 3);
    assert.equal(p.pdf.doc, docId);
    assert.match(p.pageText, /Gauss on the second page/);
    assert.doesNotMatch(p.pageText, /first page/);
    assert.deepEqual([p.x, p.y], [700, 0]);
  });

  test("only pages it has", async () => {
    assert.equal((await s.api("POST", `/api/canvases/pdfs0001/docs/${docId}/pages`, { page: 4, x: 0, y: 0 })).status, 400);
    assert.equal((await s.api("POST", `/api/canvases/pdfs0001/docs/${docId}/pages`, { page: 0, x: 0, y: 0 })).status, 400);
    assert.equal((await s.api("POST", "/api/canvases/pdfs0001/docs/nothere/pages", { page: 1, x: 0, y: 0 })).status, 404);
  });
});
