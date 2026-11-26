// Math that real LaTeX reads but KaTeX doesn't (as Wikipedia writes it), mended before giving up.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import katex from "katex";
import { dropStrayCloses, repairTex, unescapeTwice } from "../../shared/tex.ts";
import { readTabular, splitTabulars } from "../../src/tabular.ts";

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

describe("F-START-1: a table in a boxed page's transcription", () => {
  // As the model transcribed Table 2 of "Judging LLM-as-a-Judge".
  const t = String.raw`Table 2: Position bias of different LLM judges.

\begin{tabular}{l l r r}
Judge & Prompt & Consistency & Biased toward first \\
\hline
Claude-v1 & default & 23.8\% & \textbf{75.0\%} \\
 & rename & 56.2\% & 11.2\% \\
\hline
GPT-4 & default & \textbf{65.0\%} & 30.0\% \\
\end{tabular}

The two largest numbers in each column are in bold.`;

  test("is split into the words and the table, read cell by cell", () => {
    const parts = splitTabulars(t);
    assert.deepEqual(parts.map((p) => p.kind), ["text", "table", "text"]);
    const table = (parts[1] as { kind: "table"; table: ReturnType<typeof readTabular> }).table;
    assert.deepEqual(table.rows.map((r) => r.cells.map((c) => c.text)), [
      ["Judge", "Prompt", "Consistency", "Biased toward first"],
      ["Claude-v1", "default", "23.8%", "75.0%"],
      ["", "rename", "56.2%", "11.2%"],
      ["GPT-4", "default", "65.0%", "30.0%"],
    ]);
    assert.deepEqual(table.rows.map((r) => r.ruleBelow), [true, false, true, false], "rules sit under the rows above them");
    assert.equal(table.rows[1].cells[3].bold, true, "bold numbers stay bold");
    assert.equal(table.rows[1].cells[2].bold, false);
  });

  test("a Markdown pipe table is read too, with or without its --- line", () => {
    const md = "Table 2: Position bias.\n\n| Judge | Prompt | Consistency |\n| Claude-v1 | default | **23.8%** |\n| | rename | 56.2% |\n\nAfter it.";
    const parts = splitTabulars(md);
    assert.deepEqual(parts.map((p) => p.kind), ["text", "table", "text"]);
    const table = (parts[1] as { kind: "table"; table: ReturnType<typeof readTabular> }).table;
    assert.deepEqual(table.rows.map((r) => r.cells.map((c) => c.text)), [["Judge", "Prompt", "Consistency"], ["Claude-v1", "default", "23.8%"], ["", "rename", "56.2%"]]);
    assert.equal(table.rows[0].ruleBelow, true, "the header has a rule under it");
    assert.equal(table.rows[1].cells[2].bold, true);
    const dashed = splitTabulars("| a | b |\n|---|:-:|\n| 1 | 2 |");
    assert.deepEqual((dashed[0] as { kind: "table"; table: ReturnType<typeof readTabular> }).table.rows.map((r) => r.cells.map((c) => c.text)), [["a", "b"], ["1", "2"]]);
    assert.equal(splitTabulars("| just one line |")[0].kind, "text", "one line isn't a table");
  });

  test("words with no table are left alone", () => {
    assert.deepEqual(splitTabulars("Just \\(x^2\\) here"), [{ kind: "text", text: "Just \\(x^2\\) here" }]);
  });

  test("multicolumn cells keep their text", () => {
    assert.deepEqual(readTabular(String.raw`\multicolumn{2}{c}{Both} & x \\`).rows[0].cells.map((c) => c.text), ["Both", "x"]);
  });
});

describe("text a model escaped twice", () => {
  test("loses the extra layer: real line breaks and quotes, single backslashes", () => {
    const raw = String.raw`Reasoning-based metrics\n\nPass@k = \"Probability that at least 1 of k attempts succeeds\"\n\nPass@1 = \\frac{c}{n}`;
    assert.equal(unescapeTwice(raw), 'Reasoning-based metrics\n\nPass@k = "Probability that at least 1 of k attempts succeeds"\n\nPass@1 = \\frac{c}{n}');
  });
  test("LaTeX on its own is left alone", () => {
    for (const t of [String.raw`\nabla f \neq 0`, String.raw`\frac{a}{b}`, "plain words"]) assert.equal(unescapeTwice(t), t);
  });
});
