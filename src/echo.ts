// Telling the librarian's voice from yours on a call.
// The microphone stays open while the librarian talks (so you can cut in), and it hears the
// speakers too. What it hears that repeats a run of five or more of the librarian's own words,
// in order, is its echo, and is taken out; whatever's left is you.

const RUN = 5;
const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** `heard` without any run of RUN or more words the librarian said (in `said`), in its own words. */
export function withoutEcho(heard: string, said: string[]): string {
  const toks = heard.split(/\s+/).filter((t) => key(t));
  const grams = new Set<string>();
  for (const s of said) {
    const w = s.split(/\s+/).map(key).filter(Boolean);
    for (let i = 0; i + RUN <= w.length; i++) grams.add(w.slice(i, i + RUN).join(" "));
  }
  const keys = toks.map(key);
  const drop = keys.map(() => false);
  for (let i = 0; i + RUN <= keys.length; i++) {
    if (grams.has(keys.slice(i, i + RUN).join(" "))) for (let k = i; k < i + RUN; k++) drop[k] = true;
  }
  const left = toks.filter((_, i) => !drop[i]);
  // A scrap too short to match a run, but made of the librarian's words, is its echo too.
  if (left.length && left.length < RUN) {
    const words = new Set(said.flatMap((s) => s.split(/\s+/).map(key)));
    if (left.filter((t) => words.has(key(t))).length / left.length > 0.6) return "";
  }
  return left.join(" ");
}
