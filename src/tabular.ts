// A table in a transcription, as a model writes one from a boxed page (a LaTeX tabular or a
// Markdown pipe table), read into rows of cells so it can be drawn as a table: KaTeX can't draw tabular.

/** One table's rows, each a list of cells; a rule under a row is noted. */
export type Tabular = { rows: { cells: { text: string; bold: boolean }[]; ruleBelow: boolean }[] };

type Part = { kind: "text"; text: string } | { kind: "table"; table: Tabular };

/** A transcription split into its words and the tables among them, in order: LaTeX tabulars and Markdown pipe tables. */
export function splitTabulars(text: string): Part[] {
  return splitLatex(text).flatMap((p) => (p.kind === "text" ? splitPipes(p.text) : [p]));
}

/** Markdown pipe tables: two or more lines in a row that start and end with "|". */
function splitPipes(text: string): Part[] {
  const out: Part[] = [];
  const lines = text.split("\n");
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  let words: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!isRow(lines[i])) {
      words.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && isRow(lines[j])) j++;
    if (j - i < 2) {
      words.push(lines[i++]);
      continue;
    }
    if (words.join("\n").trim()) out.push({ kind: "text", text: words.join("\n") });
    words = [];
    out.push({ kind: "table", table: readPipes(lines.slice(i, j)) });
    i = j;
  }
  if (words.join("\n").trim()) out.push({ kind: "text", text: words.join("\n") });
  return out;
}

/** The rows of a pipe table; the header (the first row) has a rule under it. */
export function readPipes(lines: string[]): Tabular {
  const rows: Tabular["rows"] = [];
  for (const l of lines) {
    const cells = l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
    // The |---|:--:| line under a header is a rule, not a row.
    if (cells.every((c) => /^\s*:?-+:?\s*$/.test(c))) {
      if (rows.length) rows[rows.length - 1].ruleBelow = true;
      continue;
    }
    rows.push({
      cells: cells.map((c) => {
        const t = c.trim();
        const bold = /^\*\*.*\*\*$/.test(t) || /\\textbf\{/.test(t);
        return { text: cell(t.replace(/^\*\*(.*)\*\*$/, "$1")).text, bold };
      }),
      ruleBelow: false,
    });
  }
  if (rows.length) rows[0].ruleBelow = true;
  return { rows };
}

function splitLatex(text: string): Part[] {
  const out: Part[] = [];
  const re = /\\begin\{tabular\*?\}(?:\{[^}]*\})?\s*(\{(?:[^{}]|\{[^{}]*\})*\})?([\s\S]*?)\\end\{tabular\*?\}/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "table", table: readTabular(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.filter((p) => p.kind === "table" || p.text.trim());
}

/** The body of a tabular: rows split at \\, cells at unescaped &, rules from \hline and friends. */
export function readTabular(body: string): Tabular {
  const rows: Tabular["rows"] = [];
  const rule = /^\s*(\\(hline|toprule|midrule|bottomrule|cline\{[^}]*\})\s*)+/;
  for (let raw of body.split(/\\\\(?:\[[^\]]*\])?/)) {
    // A rule before a row's cells belongs under the row above.
    if (rule.test(raw)) {
      if (rows.length) rows[rows.length - 1].ruleBelow = true;
      raw = raw.replace(rule, "");
    }
    raw = raw.replace(/\\(hline|toprule|midrule|bottomrule)/g, "");
    if (!raw.trim()) continue;
    const cells = raw.split(/(?<!\\)&/).map((c) => cell(c));
    rows.push({ cells, ruleBelow: false });
  }
  return { rows };
}

function cell(c: string): { text: string; bold: boolean } {
  let t = c.trim();
  // \multicolumn{n}{align}{text} and \multirow{n}{*}{text}: just the text.
  t = t.replace(/\\multi(?:column|row)\{[^}]*\}\{[^}]*\}\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1");
  const bold = /\\textbf\{|\\bf\b|\\mathbf\{/.test(t);
  t = t
    .replace(/\\(?:textbf|textit|emph|mathbf|text|textrm|texttt)\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1")
    .replace(/\\bf\b\s*/g, "")
    .replace(/\\([%&$#_{}])/g, "$1")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text: t, bold };
}
