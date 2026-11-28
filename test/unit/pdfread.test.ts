// F-PDF-READ: a PDF is read whole, each paragraph knowing its page, and cut into passages that can
// be searched by keywords (and by meaning, when there are embeddings).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { useEnv } from "../helpers/env.ts";

// No settings file: no embeddings, so searching is by keywords alone.
useEnv({ SEMSHAPES_CONFIG: "/nonexistent/config.json" });
const { pageParagraphs, placeOnPages, withoutReferences } = await import("../../server/pdftext.ts");
const { keywordScores, passagesOf, passageText, searchPassages } = await import("../../server/passages.ts");

describe("F-PDF-READ: a PDF read whole", () => {
  test("a page's paragraphs: lines rejoined, split words mended, headings marked, page numbers and arXiv's stamp dropped", () => {
    const page = [
      "arXiv:2506.13771v5 [cs.LG] 5 Feb 2026",
      "1",
      "Introduction",
      "Large models are costly. Quanti-\nzation lowers the\nprecision of weights.",
      "3.2 Dual-SVID Initialization",
      "We start from the SVD.",
      "7",
    ].join("\n\n");
    assert.deepEqual(pageParagraphs(page), ["## 1 Introduction", "Large models are costly. Quantization lowers the precision of weights.", "## 3.2 Dual-SVID Initialization", "We start from the SVD."]);
  });

  test("the references are left out, but an appendix after them is kept", () => {
    const paras = ["## 1 Intro", "Text.", "## References", "[1] A book.", "[2] A paper.", "## Appendix A Proofs", "Proof."].map((text, i) => ({ text, page: i + 1 }));
    assert.deepEqual(withoutReferences(paras).map((p) => p.text), ["## 1 Intro", "Text.", "## Appendix A Proofs", "Proof."]);
  });

  test("paragraphs read elsewhere (arXiv's HTML) are placed on the PDF's pages, despite citations and formulas", () => {
    const pages = ["Introduction\n\nLarge language models based on the Transformer architecture [1] have trans-\nformed language processing.", "Method\n\nWe represent weights via low-rank latent matrix factorization and binarize the factors."];
    const paras = ["## 1 Introduction", "Large language models based on the Transformer architecture have transformed language processing.", "## 2 Method", "We represent weights via low-rank latent matrix factorization \\(W \\approx UV^T\\) and binarize the factors."];
    // A heading isn't found on its own: it takes the page of what follows it.
    assert.deepEqual(placeOnPages(paras, pages), [1, 1, 2, 2]);
  });

  test("passages gather paragraphs within a section, never across a heading, and carry their pages", () => {
    const text = ["## 1 Intro", "Alpha one.", "Alpha two.", "## 2 Method", "Beta one."].join("\n\n");
    const ps = passagesOf(text, [1, 1, 2, 3, 3]);
    assert.deepEqual(
      ps.map((p) => [p.section, p.text, p.pages]),
      [
        ["1 Intro", "Alpha one.\n\nAlpha two.", [1, 2]],
        ["2 Method", "Beta one.", [3]],
      ],
    );
    assert.match(passageText(ps.slice(1)), /^\[p\. 3; 2 Method\]\nBeta one\.$/);
  });

  test("a long section is cut into several passages", () => {
    const para = "word ".repeat(200).trim();
    const ps = passagesOf(["## S", para, para, para].join("\n\n"));
    assert.equal(ps.length, 3);
    assert.ok(ps.every((p) => p.section === "S"));
  });

  test("keywords find a paper's own term, and without embeddings that's the ranking", async () => {
    const text = ["## 1 Intro", "Models are large and costly to serve on small devices.", "## 3.2 Initialization", "Dual-SVID splits each factor into its sign and its magnitude before training.", "## 4 Results", "Perplexity stays low at 0.1 bits per weight."].join("\n\n");
    const ps = passagesOf(text);
    const scores = keywordScores(ps, "what does Dual-SVID do?");
    assert.ok(scores[1] > 0 && scores[0] === 0 && scores[2] === 0);
    const found = await searchPassages(ps, "how is it initialized? Dual-SVID", 2);
    assert.equal(found[0].section, "3.2 Initialization");
  });
});
