// Mending LaTeX that real LaTeX accepts but KaTeX doesn't, and delimiters models leave stray.

const ACCENTS = "dot|ddot|dddot|hat|bar|tilde|vec|check|breve|acute|grave|mathring|widehat|widetilde|overline|underline|overrightarrow|overleftarrow";

/**
 * `\dot\boldsymbol{q}` is fine in LaTeX (the accent takes the whole macro) but KaTeX takes only
 * `\boldsymbol` as the accent's argument and fails. Wikipedia writes it that way. Brace it:
 * `\dot{\boldsymbol{q}}`. Nested the same way (`\dot\vec\boldsymbol{x}`) is mended from the inside.
 */
export function repairTex(tex: string): string {
  const accent = new RegExp(`\\\\(${ACCENTS})\\s*(\\\\[a-zA-Z]+\\s*\\{[^{}]*\\})`, "g");
  let out = tex;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(accent, (_, a: string, arg: string) => `\\${a}{${arg}}`);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Closing math delimiters with nothing to close, in text outside math ("…-dimensional)\)"), removed. */
export const dropStrayCloses = (text: string): string => text.replace(/\\[)\]]/g, "");

/**
 * Text a model escaped twice reaches us with a literal backslash-n and backslash-quote in it, like
 * metrics\n\nPass@k = \"…\". Undoes that one extra layer, only when a doubled \n\n or a \" gives it
 * away: LaTeX itself has \nabla and \neq.
 */
export function unescapeTwice(t: string): string {
  if (!/\\n\\n|\\"/.test(t)) return t;
  try {
    const out = JSON.parse(`"${t.replace(/(^|[^\\])"/g, '$1\\"')}"`);
    return typeof out === "string" ? out : t;
  } catch {
    return t;
  }
}
