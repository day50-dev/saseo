// Math that real LaTeX reads but KaTeX doesn't (as Wikipedia writes it), mended before giving up.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import katex from "katex";
import { dropStrayCloses, repairTex } from "../../shared/tex.ts";

const renders = (t: string) => {
  try {
    katex.renderToString(t, { throwOnError: true, strict: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("F-MATH: mending LaTeX for KaTeX", () => {
  // From Wikipedia's "Hamiltonian mechanics", as read off the page.
  const wiki = [
    String.raw`\frac{\partial \mathcal L}{\partial \boldsymbol{q}} - \frac{d}{dt}\frac{\partial \mathcal L}{\partial \dot\boldsymbol{q}} = 0`,
    String.raw`\mathcal{L}(\boldsymbol{q},\dot\boldsymbol{q}) + \mathcal{H}(\boldsymbol{p},\boldsymbol{q}) = \boldsymbol{p}\dot\boldsymbol{q}`,
    String.raw`\dot{\boldsymbol{p}} = \frac{\mathrm{d}}{\mathrm{d}t} \frac{\partial \mathcal{L}}{\partial \dot\boldsymbol{q}} = -\frac{\partial\mathcal{H}}{\partial\boldsymbol{q}}.`,
  ];
  test("an accent on a macro with an argument is braced, and then it renders", () => {
    for (const t of wiki) {
      assert.equal(renders(t), false, `KaTeX should reject the original: ${t}`);
      assert.equal(renders(repairTex(t)), true, repairTex(t));
    }
    assert.equal(repairTex(String.raw`\dot\boldsymbol{q}`), String.raw`\dot{\boldsymbol{q}}`);
    assert.equal(repairTex(String.raw`\hat \mathbf{x} + \vec\mathcal{A}`), String.raw`\hat{\mathbf{x}} + \vec{\mathcal{A}}`);
  });
  test("what already works is left alone", () => {
    for (const t of [String.raw`\dot{\boldsymbol{q}}`, String.raw`\dot q^1`, String.raw`\boldsymbol{\dot q}`, String.raw`\dot\alpha`]) assert.equal(repairTex(t), t);
  });
  test("a closing delimiter left in plain text goes", () => {
    assert.equal(dropStrayCloses(String.raw`-dimensional)\) equation`), "-dimensional) equation");
  });
});
