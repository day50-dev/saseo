// The page itself, in headless Chrome against the real server (built client, fake model): the home
// page, each kind of card drawing and responding to the mouse, removing and Undo, a card's
// conversation, and a call that numbers things on screen and takes a pick.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, objectCard, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, CardItem } from "../../shared/canvas.ts";

const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const llm = await fakeLlm();
const env = testEnv(llm.url);
let s: TestServer;
let browser: Browser;

const sem = explained("eig", "Eigenvectors", 0, 0);
before(async () => {
  seed(env.LIBRARIAN_DATA, [
    { id: "diag0001", name: "Diagram", items: [sem] },
    { id: "plot0001", name: "Plot", items: [objectCard("p", { type: "plot", title: "Sine", plot: { x: { min: -6, max: 6 }, y: {}, series: [{ label: "sin", fn: "sin(x)" }, { label: "1/x", fn: "1/x" }], marks: [{ x: 0, y: 0, label: "origin" }] } })] },
    { id: "tabl0001", name: "Table", items: [objectCard("t", { type: "table", title: "Populations", columns: ["year", "people"], rows: [[1900, 5], [1950, 9], [2000, 14]], sources: [{ title: "Census", url: "https://example.org/census" }] })] },
    { id: "grph0001", name: "Graph", items: [objectCard("g", { type: "graph", title: "A tree", directed: true, nodes: [{ id: "r", label: "root" }, { id: "a", label: "left" }, { id: "b", label: "right" }], edges: [{ from: "r", to: "a" }, { from: "r", to: "b" }] })] },
    { id: "map00001", name: "Map", items: [objectCard("m", { type: "map", title: "Lagrange", route: true, places: [{ name: "Turin", lat: 45.07, lon: 7.69, note: "born" }, { name: "Berlin", lat: 52.52, lon: 13.4 }, { name: "Paris", lat: 48.86, lon: 2.35, approximate: true }] })] },
    { id: "undo0001", name: "Undo", items: [explained("u1", "Keep me", 0, 0), explained("u2", "Remove me", 800, 0)] },
    { id: "chat0001", name: "Chat", items: [explained("c1", "Eigenvalues", 0, 0)] },
    {
      id: "set00001",
      name: "Set",
      items: [
        objectCard("s1", { type: "set", title: "Post-punk", caption: "The bands.", entries: ["Joy Division", "The Fall", "Siouxsie and the Banshees", "Wire", "Gang of Four", "Magazine"].map((t, i) => ({ title: t, subtitle: "band", note: `Reason ${i + 1}`, url: `https://en.wikipedia.org/wiki/${t.replace(/ /g, "_")}`, ...(i === 5 ? { unverified: true, url: undefined } : {}) })) }, 0, 0, { w: 960 }),
      ],
    },
    { id: "srcs0001", name: "Sources", items: [explained("w1", "The Smiths", 0, 0, { sources: [{ n: 1, url: "http://127.0.0.1:9/no-such-page", title: "The Smiths", snippet: "", searcher: "keenable" }] })] },
    {
      id: "vids0001",
      name: "Videos",
      items: [
        explained("h1", "Hamiltonian", 0, 0, { h: 400 }),
        objectCard("vs", { type: "videos", videos: [{ url: "https://www.youtube.com/watch?v=AAAAAAAAAAA", videoId: "AAAAAAAAAAA", title: "Lecture one", snippet: "", channel: "MIT" }, { url: "https://www.youtube.com/watch?v=BBBBBBBBBBB", videoId: "BBBBBBBBBBB", title: "Lecture two", snippet: "", channel: "Stanford" }] }, 800, 0, { h: 500 }),
      ],
    },
    {
      id: "diag0002",
      name: "Clipped diagram",
      items: [objectCard("d1", { type: "diagram", caption: "A label past the edge", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><line x1="10" y1="100" x2="390" y2="100" stroke="black"/><text x="370" y="95" font-size="20">Position (q)</text></svg>' }, 0, 0)],
    },
    { id: "note0001", name: "Notes", items: [explained("n1", "Bialgebras", 0, 0)] },
    {
      id: "mome0001",
      name: "Moment",
      items: [
        { kind: "image", id: "fr1", asset: "", name: "24:22 · A lecture", x: 0, y: 0, w: 640, h: 360, naturalW: 1280, naturalH: 720, topic: "A lecture", moment: { videoImageId: "v0", videoId: "AAAAAAAAAAA", t: 1462, title: "A lecture" }, transcript: "[23:37–24:32] pass at k is one minus the chance all k attempts fail" },
        { kind: "card", id: "said1", parentId: "fr1", origin: { kind: "note", title: "pass at k" }, x: 0, y: 408, w: 640, stage: "done", subject: "What was said at 24:22", pageText: "pass at k is one minus the chance all k attempts fail" },
      ],
    },
    {
      id: "look0001",
      name: "Look",
      items: [
        { kind: "image", id: "fr2", asset: "", name: "45:45 · A lecture", x: 0, y: 0, w: 640, h: 360, naturalW: 1920, naturalH: 1080, topic: "A lecture" },
        explained("lk1", "Position bias", 720, 0, { parentId: "fr2", lookImage: "fr2", looking: "done", looks: { "what-0": { x: 75, y: 25, w: 431, h: 84 }, "here-0": { x: 100, y: 200, w: 1700, h: 400 } } }),
      ],
    },
    {
      id: "cnot0001",
      name: "Call notes",
      items: [
        explained("q1", "Solitons", 0, 0),
        { kind: "note", id: "bps1", text: "Bogomol'nyi–Prasad–Sommerfield bound", by: "you", at: "2026-11-24T10:00:00Z", x: 900, y: 0, w: 340, context: { via: "canvas", seq: 1 } },
      ],
    },
    {
      id: "call0001",
      name: "Call",
      items: [
        explained("k0", "Graphs", 0, 0, { h: 500 }),
        objectCard("k1", { type: "graph", title: "K4", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] }, 800, 0),
        objectCard("k2", { type: "graph", title: "Petersen", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] }, 1600, 0),
      ],
    },
  ]);
  s = await startServer(env);
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
});
after(async () => {
  await browser?.close();
  await s?.stop();
  await llm.close();
});

async function open(path: string, width = 1600, height = 1000): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write", "microphone"], { origin: s.url });
  // Headless Chrome has no speech service: the test speaks for the reader, and the voice is silent.
  await ctx.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.webkitSpeechRecognition = w.SpeechRecognition = class {
      constructor() {
        w.__rec = this;
      }
      start() {}
      stop() {}
      abort() {}
    };
    speechSynthesis.speak = (u: SpeechSynthesisUtterance) => void setTimeout(() => u.onend?.(new Event("end") as SpeechSynthesisEvent), 300);
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  (page as Page & { errors: string[] }).errors = errors;
  await page.goto(`${s.url}${path}`);
  return page;
}
const errorsOf = (p: Page) => (p as Page & { errors: string[] }).errors;
const cardSel = (id: string) => `.card-item[data-card-id="${id}"]`;
const state = async (cid: string) => ((await s.api("GET", `/api/canvases/${cid}`)).body as CanvasState).items;

describe("the home page", () => {
  test("lists your canvases, offers examples, and starts a blank canvas with one button", async () => {
    const p = await open("/");
    await p.getByText("Undo", { exact: true }).first().waitFor();
    assert.match((await p.textContent("body")) ?? "", /eigenvectors/i, "the examples");
    assert.equal(await p.locator(".new-canvas input").count(), 0, "no name to make up first");
    await p.getByRole("button", { name: "Start exploring" }).click();
    await p.waitForURL(/\/c\/[0-9a-f]{8}$/);
    // The canvas asks where to start; it's named after that later.
    await p.waitForSelector('[placeholder^="A link to read"], [placeholder^="Paste a link"]');
    const id = p.url().split("/").pop()!;
    assert.equal((await s.api("GET", `/api/canvases/${id}`)).body.name, "Untitled canvas");
    assert.deepEqual(errorsOf(p), []);
    await p.context().close();
  });

  test("an unknown canvas says so", async () => {
    const p = await open("/c/zzzzzzzz");
    await p.waitForFunction(() => /not found|doesn't exist|no canvas|missing/i.test(document.body.innerText));
    await p.context().close();
  });
});

describe("F-SHAPES: an explanation drawn as a diagram", () => {
  test("its pieces are on the card, each with a + to grow it", async () => {
    const p = await open("/c/diag0001");
    const card = p.locator(cardSel("eig"));
    await card.waitFor();
    for (const t of ["People needed Eigenvectors", "Eigenvectors in one line", "A detail about Eigenvectors"]) assert.ok((await card.textContent())!.includes(t), t);
    assert.ok((await card.locator("button", { hasText: "+" }).count()) >= 2);
    assert.deepEqual(errorsOf(p), []);
    await p.context().close();
  });
});

describe("F-FIG: figures on the canvas", () => {
  test("a plot draws its curves, broken at asymptotes, and reads values under the cursor", async () => {
    const p = await open("/c/plot0001");
    const svg = p.locator(`${cardSel("p")} .figure-plot svg`).first();
    await svg.waitFor();
    assert.ok((await svg.locator("path").count()) >= 3, "sin, and 1/x in two pieces");
    assert.ok((await p.textContent(cardSel("p")))!.includes("origin"), "the mark is labelled");
    const b = (await svg.boundingBox())!;
    await p.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2);
    await p.waitForSelector(`${cardSel("p")} .figure-readout`);
    assert.match((await p.textContent(`${cardSel("p")} .figure-readout`))!, /x = /);
    assert.match((await svg.getAttribute("data-f")) ?? "", /plot/);
    await p.context().close();
  });

  test("a table lists its rows and sources, charts itself, and copies as CSV", async () => {
    const p = await open("/c/tabl0001");
    const card = p.locator(cardSel("t"));
    await card.locator("table").waitFor();
    assert.equal(await card.locator("tbody tr").count(), 3);
    assert.ok((await card.textContent())!.includes("Census"));
    await card.getByRole("button", { name: "Chart it" }).click();
    await card.locator("svg").first().waitFor();
    await card.getByRole("button", { name: "Show the table" }).click();
    await card.getByRole("button", { name: "Copy as CSV" }).click();
    await card.getByRole("button", { name: "Copied" }).waitFor();
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), "year,people\n1900,5\n1950,9\n2000,14");
    await p.context().close();
  });

  test("a graph draws its nodes in layers; nodes can be dragged and the layout reset", async () => {
    const p = await open("/c/grph0001");
    const card = p.locator(cardSel("g"));
    const root = card.locator(`[data-f^='the node "root"']`);
    await root.waitFor();
    const left = card.locator(`[data-f^='the node "left"']`);
    const [rb, lb] = [(await root.boundingBox())!, (await left.boundingBox())!];
    assert.ok(rb.y < lb.y, "the root is above its children");
    await p.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
    await p.mouse.down();
    await p.mouse.move(lb.x + 150, lb.y + 60, { steps: 5 });
    await p.mouse.up();
    const moved = (await left.boundingBox())!;
    assert.ok(Math.abs(moved.x - lb.x) > 50, "dragged");
    await card.getByRole("button", { name: "Reset layout" }).click();
    const back = (await left.boundingBox())!;
    assert.ok(Math.abs(back.x - lb.x) < 2);
    await p.context().close();
  });

  test("a map lists its places in order, flags the roughly placed one, and goes to a place when clicked", async () => {
    const p = await open("/c/map00001");
    const card = p.locator(cardSel("m"));
    await card.locator(".map-box canvas").first().waitFor({ timeout: 15000 });
    const items = card.locator(".map-places li");
    assert.deepEqual(await items.allTextContents().then((t) => t.map((x) => x.split(":")[0].replace(" roughly placed", "").trim())), ["Turin", "Berlin", "Paris"]);
    assert.ok((await items.nth(2).textContent())!.includes("roughly placed"));
    await items.nth(1).getByRole("button").click();
    await until(async () => (await items.nth(1).getAttribute("class"))?.includes("on"), 3000, "Berlin picked");
    await p.context().close();
  });
});

describe("F-DESK-2: removing, and Undo", () => {
  test("× removes a card; Ctrl+Z brings it back; Ctrl+Shift+Z removes it again", async () => {
    const p = await open("/c/undo0001");
    await p.locator(cardSel("u2")).waitFor();
    await p.locator(`${cardSel("u2")} .remove-btn`).click();
    await p.locator(cardSel("u2")).waitFor({ state: "detached" });
    assert.equal((await state("undo0001")).find((i) => i.id === "u2")!.hidden, true);
    await p.keyboard.press("Control+z");
    await p.locator(cardSel("u2")).waitFor();
    assert.equal((await state("undo0001")).find((i) => i.id === "u2")!.hidden, false);
    await p.keyboard.press("Control+Shift+z");
    await p.locator(cardSel("u2")).waitFor({ state: "detached" });
    await p.context().close();
  });
});

describe("F-NOTES: notes on the canvas", () => {
  test("N opens a note beside the selected card; it saves, rewords, shows its history, and Undo takes it away", async () => {
    const p = await open("/c/note0001");
    await p.locator(cardSel("n1")).waitFor();
    await p.locator(`${cardSel("n1")} .card-head`).click({ position: { x: 60, y: 8 } });
    await p.keyboard.press("n");
    await p.locator(".note-edit").fill("Is the 1 really needed?");
    await p.keyboard.press("Control+Enter");
    const note = p.locator(".note-item:not([data-note-id=draft])");
    await note.waitFor();
    const saved = await until(async () => (await state("note0001")).find((i) => i.kind === "note"), 5000, "the note");
    assert.equal((saved as { on?: { id: string } }).on?.id, "n1", "about the selected card");
    assert.match(await note.locator(".note-meta").innerText(), /You[\s\S]*on “Bialgebras”/);
    assert.equal(await p.locator("path.note-line").count(), 1, "a line to what it's about");

    await note.locator(".note-text").dblclick();
    await p.locator(".note-edit").fill("Is the unit really needed?");
    await p.keyboard.press("Control+Enter");
    await until(async () => (await note.locator(".note-text").innerText()) === "Is the unit really needed?", 5000, "the new wording");

    await note.getByRole("button", { name: "History" }).click();
    const h = note.locator(".note-history");
    await h.getByText("Wordings").waitFor();
    assert.match(await h.innerText(), /You left this on the canvas[\s\S]*Is the 1 really needed\?[\s\S]*Is the unit really needed\?/);

    await p.locator(".stage").click({ position: { x: 1400, y: 900 } });
    await p.keyboard.press("Control+z");
    await p.keyboard.press("Control+z");
    await note.waitFor({ state: "detached" });
    assert.deepEqual((p as Page & { errors: string[] }).errors, []);
    await p.context().close();
  });

  test("a note being written has Cancel on the left and Save on the right", async () => {
    const p = await open("/c/note0001");
    await p.locator(cardSel("n1")).waitFor();
    await p.locator(".note-add-btn").click();
    const edit = p.locator(".note-edit");
    await edit.fill("Check the 1974 constitution");
    const cancel = p.locator(".note-actions").getByRole("button", { name: "Cancel" });
    const save = p.locator(".note-actions").getByRole("button", { name: "Save" });
    assert.ok((await cancel.boundingBox())!.x < (await save.boundingBox())!.x, "Cancel left of Save");
    await save.click();
    const note = p.locator(".note-item").filter({ hasText: "Check the 1974 constitution" });
    await note.locator(".note-text").waitFor();
    // Editing it again and cancelling leaves the words as they were.
    await note.locator(".note-text").dblclick();
    await p.locator(".note-edit").fill("Something else");
    await p.locator(".note-actions").getByRole("button", { name: "Cancel" }).click();
    await p.locator(".note-edit").waitFor({ state: "detached" });
    assert.equal(await note.locator(".note-text").innerText(), "Check the 1974 constitution");
    await p.waitForTimeout(500);
    const st = (await s.api("GET", "/api/canvases/note0001")).body as CanvasState;
    assert.equal(st.items.filter((i) => i.kind === "note" && !i.hidden && i.text.startsWith("Check the")).length, 1, "saved once, not changed by Cancel");
    assert.equal(st.items.some((i) => i.kind === "note" && i.text === "Something else"), false);
    await p.context().close();
  });

  test("Escape drops a note that was never written", async () => {
    const p = await open("/c/note0001");
    await p.locator(cardSel("n1")).waitFor();
    await p.locator(".note-add-btn").click();
    await p.locator(".note-edit").waitFor();
    await p.keyboard.press("Escape");
    await p.locator(".note-edit").waitFor({ state: "detached" });
    await p.context().close();
  });
});

describe("F-ASK: a card's conversation", () => {
  test("Enter sends; the answer appears on the card", async () => {
    llm.reset();
    llm.on(/conversation box on a card/, { kind: "answer", request: "x" });
    llm.on(/talking with a curious/, "An eigenvalue is how much the arrow stretches.");
    const p = await open("/c/chat0001");
    const box = p.locator(`${cardSel("c1")} textarea.chat-input`);
    await box.fill("What's an eigenvalue?");
    await box.press("Enter");
    await p.getByText("An eigenvalue is how much the arrow stretches.").waitFor();
    assert.ok((await p.textContent(cardSel("c1")))!.includes("What's an eigenvalue?"));
    await p.context().close();
  });
});

describe("F-CALL: a call that numbers things and takes a pick", () => {
  test("an ambiguous request numbers the candidates on screen; clicking a number answers it", async () => {
    llm.reset();
    llm.on(/voice call/, (a) =>
      /They picked number 2/.test(a.user)
        ? { say: "Taking off the Petersen graph.", actions: [{ kind: "remove", ids: ["k2"] }] }
        : { say: "Which one? I've numbered them: just say the number.", actions: [{ kind: "mark", marks: [{ card: "k1", label: "K4" }, { card: "k2", label: "Petersen" }] }] },
    );
    const p = await open("/c/call0001", 2600, 1000);
    await p.locator(cardSel("k2")).waitFor();
    await p.click(".call-btn");
    await p.waitForFunction(() => Boolean((window as unknown as { __rec?: unknown }).__rec));
    await p.waitForTimeout(500);
    const say = (t: string) =>
      p.evaluate((text) => {
        const rec = (window as unknown as { __rec: Record<string, (e: unknown) => void> }).__rec;
        rec.onspeechstart?.({});
        rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: text } }, { isFinal: true })] });
      }, t);
    await say("get rid of the graph");
    await p.locator(".call-mark").first().waitFor({ timeout: 10000 });
    assert.equal(await p.locator(".call-mark").count(), 2);
    assert.ok(await p.locator(`${cardSel("k1")}.call-marked, ${cardSel("k1")} .call-marked`).count() + (await p.locator(".call-marked").count()) > 0, "candidates are outlined");
    const chips = p.locator(".call-choices button");
    assert.equal(await chips.count(), 2);
    await chips.nth(1).click();
    await p.locator(cardSel("k2")).waitFor({ state: "detached", timeout: 10000 });
    assert.equal((await state("call0001")).find((i) => i.id === "k2")!.hidden, true);
    assert.equal(await p.locator(".call-mark").count(), 0, "the numbers go once answered");
    await p.getByText("Taking off the Petersen graph.").waitFor();
    assert.match(llm.askedFor(/voice call/).at(-1)!.user, /\(id k2\)/);
    await p.context().close();
  });
});

describe("F-NOTES: a call reads notes", () => {
  test("pointing at a note on a call sends the note, and its words", async () => {
    llm.reset();
    llm.on(/voice call/, { say: "Your note says the BPS bound.", actions: [] });
    const p = await open("/c/cnot0001", 1600, 1000);
    const note = p.locator('.note-item[data-note-id="bps1"]');
    await note.waitFor();
    await p.click(".call-btn");
    await p.waitForFunction(() => Boolean((window as unknown as { __rec?: unknown }).__rec));
    await p.waitForTimeout(500);
    await note.locator(".note-text").hover();
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      const rec = (window as unknown as { __rec: Record<string, (e: unknown) => void> }).__rec;
      rec.onspeechstart?.({});
      rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: "can you read my note" } }, { isFinal: true })] });
    });
    await p.getByText("Your note says the BPS bound.").waitFor({ timeout: 10000 });
    assert.match(llm.askedFor(/voice call/).at(-1)!.user, /their note, which says "Bogomol'nyi–Prasad–Sommerfield bound"/);
    await p.context().close();
  });
});

describe("F-CALL-7: typing into a call", () => {
  test("typed text shows as [text 1: …], waits for the next words, then goes with them; what it opens comes into view", async () => {
    llm.reset();
    llm.on(/.*/, { kind: "answer", request: "x" });
    llm.on(/voice call/, { say: "Opening it as a new card.", actions: [{ kind: "open", text: "text 1" }] });
    const p = await open("/c/cnot0001", 1600, 1000);
    await p.locator(cardSel("q1")).waitFor();
    await p.click(".call-btn");
    await p.waitForFunction(() => Boolean((window as unknown as { __rec?: unknown }).__rec));
    const box = p.getByLabel("Text for the librarian");
    await box.fill("What saturates the BPS bound?");
    await box.press("Enter");
    const sent = p.locator(".call-turn.sent");
    await sent.waitFor();
    assert.match(await sent.innerText(), /\[text 1: What saturates the BPS bound\?\][\s\S]*the next time you speak/);
    assert.equal(await box.inputValue(), "");
    assert.equal(llm.askedFor(/voice call/).length, 0, "nothing is sent until they speak");
    await p.evaluate(() => {
      const rec = (window as unknown as { __rec: Record<string, (e: unknown) => void> }).__rec;
      rec.onspeechstart?.({});
      rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: "i sent you something, can you open it as a new card" } }, { isFinal: true })] });
    });
    await p.getByText("Opening it as a new card.").waitFor({ timeout: 10000 });
    assert.match(llm.askedFor(/voice call/).at(-1)!.user, /\[text 1\] \(new, sent since they last spoke\): What saturates the BPS bound\?/);
    await until(async () => !(await sent.innerText()).includes("next time you speak"), 5000, "the hint to go");
    const made = (await state("cnot0001")).find((i) => i.kind === "card" && i.subject === "What saturates the BPS bound?")!;
    await p.locator(cardSel(made.id)).waitFor();
    const r = await p.locator(cardSel(made.id)).boundingBox();
    assert.ok(r && r.x > -50 && r.x < 1600, `brought into view: ${JSON.stringify(r)}`);
    await p.context().close();
  });
});

describe("F-CALL-8: what you say grows on screen, and waits a pause you set", () => {
  test("phrases gather in the log; the bar runs down after you stop; − and + change the pause; clicking the bar sends now", async () => {
    llm.reset();
    llm.on(/voice call/, { say: "Here's my answer.", actions: [] });
    const p = await open("/c/cnot0001", 1600, 1000);
    await p.locator(cardSel("q1")).waitFor();
    await p.click(".call-btn");
    await p.waitForFunction(() => Boolean((window as unknown as { __rec?: unknown }).__rec));
    const result = (text: string, final: boolean) =>
      p.evaluate(([t, f]) => {
        const rec = (window as unknown as { __rec: Record<string, (e: unknown) => void> }).__rec;
        rec.onresult({ resultIndex: 0, results: [Object.assign({ 0: { transcript: t } }, { isFinal: f })] });
      }, [text, final] as const);
    const bar = p.locator(".call-wait-bar");
    assert.equal((await bar.innerText()).trim(), "1.5 s", "the default pause");
    await p.getByRole("button", { name: "Longer pause" }).click();
    await p.getByRole("button", { name: "Longer pause" }).click();
    assert.equal((await bar.innerText()).trim(), "3 s");
    assert.equal(await p.evaluate(() => localStorage.getItem("librarian.callWait")), "3", "remembered");

    await result("so the bound says", false);
    const live = p.locator(".call-turn.you.live");
    await live.getByText("so the bound says").waitFor();
    await result("so the bound says the energy is at least", true);
    await live.getByText("so the bound says the energy is at least").waitFor();
    await p.locator(".call-wait-bar.running").waitFor();
    await result("the charge", false);
    await p.locator(".call-wait-bar.running").waitFor({ state: "detached" });
    await result("the charge times a constant, why is that", true);
    await p.locator(".call-wait-bar.running").waitFor();
    await p.waitForTimeout(800);
    assert.equal(llm.askedFor(/voice call/).length, 0, "still waiting out the 3 s pause");
    await bar.click();
    await p.getByText("Here's my answer.").waitFor({ timeout: 5000 });
    assert.match(llm.askedFor(/voice call/)[0].user, /They just said: "so the bound says the energy is at least the charge times a constant, why is that"/);
    await live.waitFor({ state: "detached" });
    await p.context().close();
  });
});

describe("F-START: arXiv from Add", () => {
  test("there's no separate arXiv button; Add searches arXiv for what's typed in it", async () => {
    const p = await open("/c/note0001");
    await p.locator(cardSel("n1")).waitFor();
    assert.equal(await p.locator(".toolbar").getByRole("button", { name: "arXiv", exact: true }).count(), 0);
    // Kept on this machine: the search is answered here.
    let asked = "";
    await p.route("**/api/arxiv/search**", (r) => {
      asked = new URL(r.request().url()).searchParams.get("q") ?? "";
      return r.fulfill({ json: { total: 1, papers: [{ id: "1234.5678", title: "BPS monopoles", authors: ["A. Person"], summary: "On monopoles.", published: "2020-01-01", category: "hep-th", url: "https://arxiv.org/abs/1234.5678" }] } });
    });
    await p.keyboard.press("/");
    await p.locator(".start-dock input").fill("BPS monopoles");
    await p.getByRole("button", { name: "Search arXiv for “BPS monopoles”" }).click();
    await p.getByRole("dialog", { name: "Add from arXiv" }).getByText("BPS monopoles", { exact: false }).first().waitFor();
    await until(() => asked === "BPS monopoles", 5000, "the search");
    assert.equal(await p.locator(".start-dock").count(), 0, "Add closed behind it");
    await p.context().close();
  });
});

describe("F-SET: a card set", () => {
  test("six tiles, three across, each linked; the unchecked one says so; Explain opens a card on it", async () => {
    const p = await open("/c/set00001");
    const set = p.locator(`${cardSel("s1")} .card-set`);
    await set.waitFor();
    assert.equal(await set.locator(".set-tile").count(), 6);
    const cols = await set.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    assert.equal(cols, 3);
    assert.equal(await set.getByRole("link", { name: "Wikipedia ↗" }).count(), 5);
    await set.locator(".set-tile.unverified").getByText("Not checked").waitFor();
    await set.locator(".set-tile").filter({ hasText: "Wire" }).getByRole("button", { name: "Explain" }).click();
    const made = await until(async () => (await state("set00001")).find((i) => i.kind === "card" && (i as CardItem).selection === "Wire"), 5000, "a card on Wire");
    assert.equal((made as CardItem).parentId, "s1");
    await p.context().close();
  });
});

describe("F-START: adding a found page", () => {
  test("found pages show their site, not the searcher; + Add puts one on the canvas beside the card", async () => {
    const p = await open("/c/srcs0001");
    const c = p.locator(cardSel("w1"));
    await c.locator(".found").waitFor();
    assert.doesNotMatch(await c.locator(".found").innerText(), /keenable/);
    await c.locator(".found li").first().getByRole("button", { name: "+ Add" }).click();
    await c.locator(".found li").first().getByRole("button", { name: "Added ✓" }).waitFor();
    const page = await until(async () => (await state("srcs0001")).find((i) => i.kind === "card" && (i as CardItem).origin?.kind === "page"), 5000, "the page card");
    const pc = page as CardItem;
    assert.equal(pc.origin?.kind === "page" && pc.origin.url, "http://127.0.0.1:9/no-such-page");
    assert.ok(pc.x >= 720, `beside the card: x=${pc.x}`);
    await p.context().close();
  });
});

describe("F-SET: videos from a set play on the canvas", () => {
  test("Play puts the video on the canvas beside the set, as a video that can be stopped and asked about", async () => {
    const p = await open("/c/vids0001");
    // Nothing goes to YouTube from a test.
    await p.route(/youtube|ytimg/, (r) => r.abort());
    let body: { input?: string; x?: number; y?: number } = {};
    await p.route("**/api/canvases/vids0001/sources", async (r) => {
      body = r.request().postDataJSON();
      await r.fulfill({ json: { image: { kind: "image", id: "vnew0001", asset: "", name: "Lecture two", x: body.x, y: body.y, w: 720, h: 405, naturalW: 1280, naturalH: 720, video: { videoId: "BBBBBBBBBBB", title: "Lecture two", channel: "Stanford", duration: 100, embeddable: true } } } });
    });
    const tile = p.locator(`${cardSel("vs")} .set-tile`).filter({ hasText: "Lecture two" });
    await tile.locator(".set-actions").getByRole("button", { name: "▶ Play on the canvas" }).click();
    await until(() => body.input === "https://www.youtube.com/watch?v=BBBBBBBBBBB", 5000, "the video to be added");
    assert.ok((body.x ?? 0) >= 800 + 720, `beside the set: x=${body.x}`);
    assert.equal(await p.locator(`${cardSel("vs")} iframe`).count(), 0, "not played inside the tile");
    await p.context().close();
  });

  test("several videos played one after another each get their own space", async () => {
    const p = await open("/c/vids0001");
    await p.route(/youtube|ytimg/, (r) => r.abort());
    const asked: { input: string; x: number; y: number }[] = [];
    await p.route("**/api/canvases/vids0001/sources", async (r) => {
      const b = r.request().postDataJSON();
      asked.push(b);
      // Slow to arrive, so the next is asked for before this one is on the canvas.
      await new Promise((ok) => setTimeout(ok, 800));
      const id = `vnew000${asked.length}`;
      await r.fulfill({ json: { image: { kind: "image", id, asset: "", name: id, x: b.x, y: b.y, w: 720, h: 405, naturalW: 1280, naturalH: 720, video: { videoId: b.input.slice(-11), title: id, channel: "", duration: 100, embeddable: true } } } });
    });
    const plays = p.locator(`${cardSel("vs")} .set-tile .set-actions`).getByRole("button", { name: "▶ Play on the canvas" });
    await plays.first().waitFor();
    const n = Math.min(3, await plays.count());
    assert.ok(n >= 2, "the set has at least two videos");
    for (let i = 0; i < n; i++) await plays.nth(i).click();
    await until(() => asked.length === n, 5000, "every video to be added");
    const ys = asked.map((a) => a.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 405, `stacked apart, not on top of each other: ${ys}`);
    await p.context().close();
  });
});

describe("F-DIAGRAM: nothing drawn is cut off", () => {
  test("a label past the drawing's edge widens its frame", async () => {
    const p = await open("/c/diag0002");
    const img = p.locator(`${cardSel("d1")} .object-diagram img`);
    await img.waitFor();
    const src = decodeURIComponent((await img.getAttribute("src"))!);
    const vb = src.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
    assert.ok(vb[0] + vb[2] > 470, `the frame reaches past the label's end: ${vb}`);
    assert.doesNotMatch(src, /width="400"/, "sized by its frame");
    await p.context().close();
  });
});

describe("F-MOMENT: a stopped moment and what was said at it", () => {
  test("F-LOOK: what a piece points at is shown about as big as it is on the canvas, not at the frame's full size", async () => {
    // A 1920-wide frame shown 640 wide; the piece points at the slide's 431-pixel title.
    const p = await open("/c/look0001");
    const look = p.locator('.card-item[data-card-id="lk1"] .look').first();
    await look.waitFor();
    const w = await look.evaluate((el) => (el as HTMLElement).offsetWidth);
    assert.ok(w <= 431 * (640 / 1920) * 1.5 + 1, `a modest picture, not a banner (${w}px)`);
    assert.ok(w >= 150, `still big enough to read (${w}px)`);
    // A wide region (a whole diagram) is held to half the card.
    const wide = await p.locator('.card-item[data-card-id="lk1"] .look').nth(1).evaluate((el) => (el as HTMLElement).offsetWidth);
    assert.ok(wide <= 361, `a whole diagram is held to half the card (${wide}px)`);
    await p.close();
  });

  test("are joined by the description connector (a bend, a straight bus, an arrowhead), which follows a move", async () => {
    const p = await open("/c/mome0001");
    const line = p.locator('path.moment-line[data-card="said1"]');
    await line.waitFor({ state: "attached" });
    const d = (await line.getAttribute("d"))!;
    assert.doesNotMatch(d, /C/, "straight runs, not the soft curve of a descent");
    assert.match(d, /^M28 360 L42 374/, "a 45° bend off the frame's bottom");
    assert.equal(await p.locator("path.moment-head").count(), 1, "an arrowhead into the words");
    if (process.env.MOMENT_SHOT) await p.screenshot({ path: process.env.MOMENT_SHOT });
    // Moved beside the frame: the line comes out of its side instead.
    await s.api("POST", "/api/canvases/mome0001/move", { moves: [{ id: "said1", x: 720, y: 0 }] });
    await p.reload();
    await line.waitFor({ state: "attached" });
    assert.match((await line.getAttribute("d"))!, /^M640 28 L654 42/);
    await p.context().close();
  });
});

describe("F-PHONE: it works on a phone", () => {
  test("a canvas opens at phone width without the page scrolling sideways", async () => {
    const p = await open("/c/diag0001", 375, 812);
    await p.locator(cardSel("eig")).waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await p.context().close();
  });
});

export type { CardItem };
