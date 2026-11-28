// F-PDF-READ: a PDF on the canvas has its reading beside it: the whole text, each paragraph with
// its page, embedded for finding things in it. Its conversation is given the passages that bear
// on what's asked, with their pages, and can open cards on the concepts in it. Through the real
// server, a real (small) PDF read by poppler, and a fake model and embeddings endpoint.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { makeParagraphPdf } from "../helpers/pdf.ts";
import { seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, CardItem, ImageItem } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
let s: TestServer;
const C = "/api/canvases/pdfr0001";
const FILE = "0123456789abcdef.pdf";

before(async () => {
  // Embeddings from the fake's own endpoint.
  const config = JSON.parse(readFileSync(env.SEMSHAPES_CONFIG, "utf8"));
  writeFileSync(env.SEMSHAPES_CONFIG, JSON.stringify({ ...config, embed: { baseUrl: llm.url, model: "fake-embed" } }));
  mkdirSync(path.join(env.LIBRARIAN_DATA, "assets"), { recursive: true });
  writeFileSync(
    path.join(env.LIBRARIAN_DATA, "assets", FILE),
    makeParagraphPdf([
      [["A Paper on Folding"], ["1"], ["Introduction"], ["Origami folds paper along creases. The crease pattern", "decides the final shape."], ["1"]],
      [["2 Method"], ["We use the Huzita axioms to place each fold, as in [3]."], ["References"], ["[3] Someone. A book on folding. 1989."], ["2"]],
    ]),
  );
  const doc: ImageItem = { kind: "image", id: "doc1", x: 0, y: 0, w: 600, h: 776, naturalW: 612, naturalH: 792, asset: "fedcba9876543210.png", name: "A Paper on Folding", doc: { file: FILE, pages: 2, url: "https://example.org/folding.pdf", title: "A Paper on Folding" } };
  // Its reading, left mid-flight: the server starts it over when it starts.
  const reading: CardItem = { kind: "card", id: "read1", parentId: "", origin: { kind: "page", url: doc.doc!.url, title: doc.doc!.title, site: "PDF, 2 pages", doc: "doc1" }, x: 664, y: 0, w: 960, stage: "reading", subject: doc.doc!.title };
  // A PDF from before readings: none beside it, and a card where one would go.
  const older: ImageItem = { ...doc, id: "doc2" };
  const inTheWay: CardItem = { kind: "card", id: "way", parentId: "", x: 664, y: 0, w: 720, h: 400, stage: "done", subject: "In the way", origin: { kind: "note", title: "In the way" }, pageText: "In the way" };
  seed(env.LIBRARIAN_DATA, [
    { id: "pdfr0001", name: "Folding", items: [doc, reading] },
    { id: "pdfr0002", name: "Older", items: [older, inTheWay] },
  ]);
  // Drawing its shapes isn't what's tested here: anything else gets an empty answer.
  llm.on(/./, "{}");
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});

const card = async (id: string) => ((await s.api("GET", C)).body as CanvasState).items.find((i) => i.id === id) as CardItem;
const chat = (text: string) => s.api("POST", `${C}/cards/read1/chat`, { text });
const replied = () =>
  until(async () => {
    const c = await card("read1");
    return !c.chatPending && c.chat?.at(-1)?.role === "assistant" ? c.chat.at(-1)!.text : null;
  }, 15_000, "the reply");

describe("F-PDF-READ: a PDF's reading", () => {
  test("the whole text is read from the file, each paragraph with its page, without the references", async () => {
    const c = await until(async () => {
      const x = await card("read1");
      return x.stage === "done" ? x : null;
    }, 15_000, "the reading");
    assert.match(c.pageText!, /## 1 Introduction/);
    assert.match(c.pageText!, /Huzita axioms/);
    assert.doesNotMatch(c.pageText!, /A book on folding/, "the references are left out");
    const paras = c.pageText!.split(/\n{2,}/);
    assert.equal(c.paraPages!.length, paras.length);
    assert.equal(c.paraPages![paras.findIndex((p) => p.includes("Huzita"))], 2);
    assert.equal(c.origin?.kind === "page" && c.origin.doc, "doc1", "it still reads that PDF");
  });

  test("a PDF from before readings gets one when the server starts, on free space; one that has one doesn't get another", async () => {
    const items = async (id: string) => ((await s.api("GET", `/api/canvases/${id}`)).body as CanvasState).items;
    const r = await until(async () => (await items("pdfr0002")).find((i): i is CardItem => i.kind === "card" && i.origin?.kind === "page" && i.origin.doc === "doc2"), 15_000, "the older PDF's reading");
    assert.ok(r.x >= 664 + 720 + 64, `placed past the card in the way: x ${r.x}`);
    await until(async () => ((await items("pdfr0002")).find((i) => i.id === r.id) as CardItem).stage === "done", 15_000, "it read");
    const readings = (await items("pdfr0001")).filter((i) => i.kind === "card" && i.origin?.kind === "page" && i.origin.doc === "doc1");
    assert.equal(readings.length, 1);
  });

  test("its passages are embedded in the background", async () => {
    await until(() => llm.embedded.some((t) => t.includes("Huzita")), 15_000, "the passages embedded");
  });

  test("a question gets the passages that bear on it, with their pages, found by keywords and meaning", async () => {
    llm.on(/conversation box on a card/, { kind: "answer", request: "which axioms" });
    llm.on(/talking with a curious/, "The Huzita axioms (p. 2).");
    assert.equal((await chat("Which axioms place the folds?")).status, 200);
    assert.equal(await replied(), "The Huzita axioms (p. 2).");
    const asked = llm.askedFor(/talking with a curious/).at(-1)!;
    assert.match(asked.system, /\[p\. 2; 2 Method\]\nWe use the Huzita axioms/);
    assert.match(asked.system, /Its sections: 1 Introduction \(p\. 1\); 2 Method \(p\. 2\)/);
    assert.ok(llm.embedded.some((t) => t.startsWith("Instruct:") && t.includes("Which axioms place the folds?")), "the question was embedded as a query");
  });

  test("asking for cards on its concepts opens one on each, hung from the reading, none stopping to ask first", async () => {
    llm.on(/conversation box on a card/, { kind: "concepts", request: "the key concepts" });
    llm.on(/pick concepts out of a text/, {
      concepts: [
        { name: "Huzita axioms", quote: "We use the Huzita axioms to place each fold, as in [3]." },
        { name: "Crease pattern", quote: "The crease pattern decides the final shape." },
      ],
    });
    assert.equal((await chat("open up a few cards on the concepts in this paper")).status, 200);
    assert.equal(await replied(), "Opened cards on Huzita axioms, Crease pattern.");
    assert.match(llm.askedFor(/pick concepts out of a text/).at(-1)!.user, /\[p\. 2; 2 Method\]/, "it picked from the paper's passages");
    const kids = ((await s.api("GET", C)).body as CanvasState).items.filter((i): i is CardItem => i.kind === "card" && i.parentId === "read1");
    assert.deepEqual(kids.map((k) => [k.selection, k.context, k.clarify?.answer]), [
      ["Huzita axioms", "We use the Huzita axioms to place each fold, as in [3].", ""],
      ["Crease pattern", "The crease pattern decides the final shape.", ""],
    ]);
  });
});
