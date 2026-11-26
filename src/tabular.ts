// A LaTeX table (\begin{tabular} … \end{tabular}), as a model transcribes one from a boxed page,
// read into rows of cells so it can be drawn as a table: KaTeX can't draw tabular.

/** One table's rows, each a list of cells; a rule under a row is noted. */
export type Tabular = { rows: { cells: { text: string; bold: boolean }[]; ruleBelow: boolean }[] };

/** A transcription split into its words and the tables among them, in order. */
export function splitTabulars(text: string): ({ kind: "text"; text: string } | { kind: "table"; table: Tabular })[] {
  const out: ({ kind: "text"; text: string } | { kind: "table"; table: Tabular })[] = [];
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
