// Small readers and cleaners: links, ids, clocks, course names, model-drawn SVG, model-written JSON.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { substantive, paragraphs } from "../../shared/canvas.ts";
import { parseArxivId } from "../../server/arxiv.ts";
import { pdfLink, titleIn } from "../../server/pdf.ts";
import { looksLikeLink, matchWikiLink } from "../../server/pages.ts";
import { around, clock, youtubeId } from "../../server/video.ts";
import { conceptKey } from "../../server/curriculum.ts";
import { partialSvg, sanitizeSvg, svgLabels } from "../../server/svg.ts";
import { repairTexEscapes } from "../../server/llm.ts";
import { pickedNumber } from "../../src/callWords.ts";

describe("F-START: what someone typed", () => {
  test("a link or a statement", () => {
    assert.ok(looksLikeLink("https://en.wikipedia.org/wiki/Eigenvalues_and_eigenvectors"));
    assert.ok(looksLikeLink("  http://example.org/a  "));
    assert.ok(!looksLikeLink("what is https://x.org about"));
    assert.ok(!looksLikeLink("eigenvectors"));
  });

  test("F-VIDEO: YouTube links in all their forms", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=PFDu9oVAE-g",
      "https://youtube.com/watch?list=x&v=PFDu9oVAE-g",
      "https://youtu.be/PFDu9oVAE-g?t=30",
      "https://www.youtube.com/shorts/PFDu9oVAE-g",
      "https://www.youtube.com/embed/PFDu9oVAE-g",
      "https://www.youtube.com/live/PFDu9oVAE-g",
    ])
      assert.equal(youtubeId(u), "PFDu9oVAE-g", u);
    assert.equal(youtubeId("https://vimeo.com/123"), null);
  });

  test("F-PDF: a PDF's title, and an empty one read as none (not as the line after it)", () => {
    assert.equal(titleIn("Title:          Judging LLM-as-a-Judge\nSubject:        \n"), "Judging LLM-as-a-Judge");
    assert.equal(titleIn("Title:          \nSubject:        \nKeywords:\n"), undefined);
    assert.equal(titleIn("Producer: pdfTeX\nPages: 29\n"), undefined);
  });

  test("F-WIKI-LINK: selected words that are a link in the Wikipedia article lead to the linked article", () => {
    const links = [
      { text: "Bradley–Terry model", title: "Bradley–Terry model", url: "https://en.wikipedia.org/wiki/Bradley%E2%80%93Terry_model" },
      { text: "Harkness", title: "Harkness rating system", url: "https://en.wikipedia.org/wiki/Harkness_rating_system" },
      { text: "zero-sum games", title: "Zero-sum game", url: "https://en.wikipedia.org/wiki/Zero-sum_game" },
    ];
    assert.equal(matchWikiLink(links, "Bradley-Terry model")?.title, "Bradley–Terry model", "a hyphen for the en dash");
    assert.equal(matchWikiLink(links, "  bradley–terry MODEL ")?.title, "Bradley–Terry model");
    assert.equal(matchWikiLink(links, "Harkness rating system")?.title, "Harkness rating system", "by the article's title");
    assert.equal(matchWikiLink(links, "zero-sum game")?.title, "Zero-sum game", "singular or plural");
    assert.equal(matchWikiLink(links, "rating"), null, "words that aren't a link");
    assert.equal(matchWikiLink(links, ""), null);
  });

  test("F-PDF: arXiv and PDF links", () => {
    assert.deepEqual(pdfLink("https://arxiv.org/abs/2609.13096"), { arxiv: "2609.13096", url: "https://arxiv.org/abs/2609.13096" });
    assert.deepEqual(pdfLink("https://arxiv.org/pdf/2609.13096v2"), { arxiv: "2609.13096v2", url: "https://arxiv.org/abs/2609.13096v2" });
    assert.deepEqual(pdfLink("https://example.org/notes.pdf?x=1"), { url: "https://example.org/notes.pdf?x=1" });
    assert.equal(pdfLink("https://example.org/notes.html"), null);
    assert.equal(pdfLink("notes.pdf"), null);
    assert.equal(parseArxivId("arXiv:hep-th/9901001v1"), "hep-th/9901001v1");
    assert.equal(parseArxivId("nothing here"), null);
  });
});

describe("F-VIDEO: moments in a lecture", () => {
  test("clock times", () => {
    assert.equal(clock(0), "0:00");
    assert.equal(clock(65.9), "1:05");
    assert.equal(clock(3725), "1:02:05");
    assert.equal(clock(-3), "0:00");
  });

  test("what was said around a moment", () => {
    const caps = [
      { t: 10, text: "too early" },
      { t: 100, text: "before" },
      { t: 150, text: "at" },
      { t: 160, text: "just after" },
      { t: 200, text: "too late" },
    ];
    assert.equal(around(caps, 150), "[1:40] before\n[2:30] at\n[2:40] (after) just after");
  });
});

describe("F-COURSES: concept names as keys", () => {
  test("one concept however it's written", () => {
    assert.equal(conceptKey("The Biot–Savart law"), "biot-savart law");
    assert.equal(conceptKey("biot-savart  LAW"), "biot-savart law");
    assert.equal(conceptKey("Schrödinger equation"), "schrodinger equation");
    assert.equal(conceptKey("an eigenvector"), "eigenvector");
  });
});

describe("F-CALL: words heard on a call", () => {
  test("noise gets no answer", () => {
    for (const s of ["", "o", "a", "um", "uh huh", "the", "thank you"]) assert.equal(substantive(s), false, s);
    for (const s of ["why", "eigenvectors", "ok", "break this down", "what is that"]) assert.equal(substantive(s), true, s);
  });

  test("a number said on its own picks a numbered thing", () => {
    assert.equal(pickedNumber("two"), 2);
    assert.equal(pickedNumber("Number 3."), 3);
    assert.equal(pickedNumber("the second one"), 2);
    assert.equal(pickedNumber("1 please"), 1);
    assert.equal(pickedNumber("five"), 5);
    assert.equal(pickedNumber("six"), undefined);
    assert.equal(pickedNumber("two of them are wrong"), undefined);
  });

  test("paragraphs", () => {
    assert.deepEqual(paragraphs("a\n\n b \n\n\nc"), ["a", "b", "c"]);
  });
});

describe("F-DIAGRAM: diagrams a model drew are cleaned before they're kept", () => {
  test("scripts, handlers, outside links and foreign content go", () => {
    const dirty = `Here you go: <svg viewBox="0 0 10 10"><script>alert(1)</script><rect onclick="x()" width="5"/><a href="https://evil"><text>t</text></a><image href="https://x/y.png"/><use href="#ok"/><use href="https://evil#x"/><foreignObject><div>hi</div></foreignObject><circle style="fill:url(https://evil)"/></svg> done`;
    const svg = sanitizeSvg(dirty)!;
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    for (const bad of ["script", "onclick", "evil", "<image", "foreignObject", "<div", "<a"]) assert.ok(!svg.includes(bad), `${bad} in ${svg}`);
    assert.ok(svg.includes('<use href="#ok">') || svg.includes('<use href="#ok"/>'));
    assert.ok(svg.includes("<rect"));
  });

  test("no svg, no diagram", () => {
    assert.equal(sanitizeSvg("I can't draw that"), null);
  });

  test("a diagram still being written draws what's finished", () => {
    const svg = partialSvg(`<svg viewBox="0 0 10 10"><g><rect width="2"/><text>hal`)!;
    assert.ok(svg.endsWith("</text></g></svg>"), svg);
    assert.equal(partialSvg(`<svg viewBox="0 0 10 10"><rect wid`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>`);
  });

  test("title and caption come from the drawing", () => {
    assert.deepEqual(svgLabels(`<svg><title>The cycle</title><desc> How <b>it</b>  turns </desc></svg>`), { title: "The cycle", caption: "How it turns" });
  });
});

describe("model-written JSON with LaTeX in it", () => {
  test("backslashes that start LaTeX commands are doubled", () => {
    const fixed = repairTexEscapes(String.raw`{"a": "\frac{1}{2} \nabla \alpha \( x \) \n"}`);
    assert.deepEqual(JSON.parse(fixed), { a: String.raw`\frac{1}{2} \nabla \alpha \( x \) ` + "\n" });
  });
});

describe("F-ARCHIVE: a page that can't be reached is read from its archived copy", () => {
  test("which failures look for a copy: the site erred, refused, timed out or lost the page", async () => {
    const { worthArchive } = await import("../../server/pages.ts");
    for (const m of ["The page answered HTTP 502.", "The page answered HTTP 404.", "The page answered HTTP 429.", "fetch failed"]) assert.ok(worthArchive(new Error(m)), m);
    const t = new Error("The operation was aborted due to timeout");
    t.name = "TimeoutError";
    assert.ok(worthArchive(t));
    for (const m of ["That link points inside a private network.", "That page is too large to read.", "The page answered HTTP 400."]) assert.ok(!worthArchive(new Error(m)), m);
  });

  test("the raw copy (id_) of the closest snapshot, and when it was taken", async () => {
    const { archivedCopy } = await import("../../server/pages.ts");
    const original = "https://encyclopediaofmath.org/wiki/Gr%C3%B6bner_basis";
    const answer = { archived_snapshots: { closest: { status: "200", available: true, url: "http://web.archive.org/web/20260716111802/x", timestamp: "20260716111802" } } };
    const copy = archivedCopy(answer, original)!;
    assert.equal(copy.url, `https://web.archive.org/web/20260716111802id_/${original}`);
    assert.equal(copy.taken.toISOString(), "2026-07-16T11:18:02.000Z");
    assert.equal(archivedCopy({ archived_snapshots: {} }, original), null);
    assert.equal(archivedCopy({ archived_snapshots: { closest: { ...answer.archived_snapshots.closest, status: "404" } } }, original), null);
    assert.equal(archivedCopy(null, original), null);
  });
});
