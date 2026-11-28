// Looking at someone's own work with them: a box drawn round a derivation, notes or an attempt at
// a problem on a photo. The people doing this are researchers and teachers working past their own
// field, so this isn't a grade: the model reads the work line by line, SymPy follows the algebra
// underneath (check_steps.py) as evidence only, and the model names what they're doing, where it
// comes from, and where they're going about it differently from the usual way, then offers cards
// (an explanation, papers, videos) and asks where to go next.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CardItem, WorkIdea, WorkLine, WorkLook } from "../shared/canvas.ts";
import { unescapeTwice } from "../shared/tex.ts";
import type { CanvasStore } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { guard, readerNotes } from "./explain.ts";
import { chatJson } from "./llm.ts";

const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "check_steps.py");

const READ_WORK = `You are reading someone's own written work: a derivation, notes, or an attempt at a problem, often handwritten. You are shown the
whole photo with a box drawn on it, then the boxed part enlarged. Transcribe the work in the box, line by line, EXACTLY as
written: never correct, skip or tidy a step, and never add steps of your own.
Return JSON only:
{"problem": "a short title in plain words for what they are working on, no LaTeX (\\"A Gaussian integral with a parameter\\"), if it's written or plain from the work (else \\"\\")",
 "steps": [{"latex": "the line as written, in LaTeX", "sympy": "the same line in SymPy syntax"}]}
SymPy syntax: * for multiplication and ** for powers (write 2*x, x**2), sqrt(), exp(), log(), sin(), cos(), tan(), pi, E, I.
- A line that is an equation: "lhs = rhs", one "=".
- A line that carries on a chain ("= 2x + 4", or the next part of "a = b = c"): just that expression, one step per part.
- A derivative: Derivative(f, x). An integral: Integral(f, x), or Integral(f, (x, a, b)) with limits. A limit: Limit(f, x, a).
- A line of words, a label ("a)", "Step 2"), a crossed-out line or a diagram: "sympy": "" (keep words in latex as \\text{...}).
- A number with units: leave the units out of sympy.
Use the same letters they use. The question itself ("Find f'(x) if…", "Solve for x") goes in "problem", not in the steps;
the steps are only their work.`;

const LOOK = `You are a research librarian looking at a colleague's own work with them: a derivation, notes, or an attempt at
a problem. They are a researcher or teacher, likely expert in their own field and exploring outside it. This is not grading:
never say right, wrong, correct, incorrect, mistake or error, and never give a verdict. Your job is to see what they are doing
and connect it to what is already known, the way a well-read colleague would: "the move you're making here has a name".
Each line comes with what a computer algebra system (SymPy) found about it against the line before ("follows", "doesn't
follow", or nothing when it couldn't tell). Treat that as evidence: where a line doesn't follow, they're going about it
differently from the usual way there, and you say what's different as an observation. Never mention SymPy, the computer
algebra or these marks to them: just say what you see.
Return JSON only:
{"opening": "1 or 2 sentences to them: what they are working on and the approach they took. Plain, peer to peer, no praise.",
 "ideas": [1 to 4 of: {
   "name": "the established name of a technique, result, identity or idea the work uses or is reaching for (as it is usually called)",
   "lines": [the line numbers where it happens],
   "what": "one sentence: what it is",
   "origin": "where it comes from, if known: who, roughly when, or the field it's usual in (else \"\")",
   "note": "1 or 2 sentences to them about how it shows up here. If they may not know it has a name, say so lightly: maybe they
            knew, maybe they found it themselves. Where their version differs from the usual one, say how, plainly.",
   "differs": true if their version differs from the usual one, else false}],
 "invite": "one short question to them about where to go next: the usual form of the move, what it leads to, or a related idea"}
A line marked "doesn't follow" is the most useful thing to raise: put it under the idea it belongs to, mark that idea
"differs", and say plainly what's different there (for example: "the usual form has \\(+\\cos x\\) here; you have
\\(-\\cos x\\)"). Never describe such a line as if it matched the usual form.
Name only ideas that carry weight in this work, genuinely established ones; skip the trivial (arithmetic, a single standard
derivative or identity) unless it's where their version differs. Don't remark on lines being fine ("this is correct",
"follows"): say what they're doing, not how well. Don't work the problem out for them.
Write math inline as LaTeX between \\( and \\).`;

/** What SymPy made of each step, in order. */
export function checkSteps(steps: string[]): Promise<{ status: "given" | "ok" | "wrong" | "unchecked"; note?: string }[]> {
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-I", CHECKER], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) return reject(new Error(`Couldn't check the steps: ${err.message.split("\n")[0]}`));
      try {
        resolve((JSON.parse(String(out)) as { results: { status: "given" | "ok" | "wrong" | "unchecked"; note?: string }[] }).results);
      } catch {
        reject(new Error("Couldn't check the steps: the checker's answer didn't parse"));
      }
    });
    child.stdin?.end(JSON.stringify({ steps }));
  });
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const FOLLOWS: Record<string, WorkLine["follows"]> = { ok: "yes", wrong: "no", unchecked: "unsure" };

/** Reads the work in a box and says what it's doing, what that's called, and where to go next. */
export function lookAtWork(store: CanvasStore, cardId: string, images: { marked: string; crop: string }) {
  return guard(store, cardId, async () => {
    const config = await loadConfig();
    await store.update(cardId, { stage: "reading" });
    const read = await chatJson<{ problem?: unknown; steps?: unknown }>(config.llm, [
      { role: "system", content: READ_WORK },
      {
        role: "user",
        content: [
          { type: "text", text: "Here is the photo, and the work I boxed." },
          { type: "image_url", image_url: { url: images.marked } },
          { type: "image_url", image_url: { url: images.crop } },
        ],
      },
    ]);
    const read_ = (Array.isArray(read.steps) ? read.steps : [])
      .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
      .map((s) => ({ latex: unescapeTwice(str(s.latex)).slice(0, 600), sympy: str(s.sympy).slice(0, 600) }))
      .filter((s) => s.latex || s.sympy)
      .slice(0, 40);
    if (!read_.length) throw new Error("Couldn't find any math in the box. Try a box around the lines of work, in a sharper photo.");
    const problem = str(read.problem).slice(0, 400);
    await store.update(cardId, { stage: "checking", subject: problem || "Your work", work: { problem, lines: read_, opening: "", ideas: [], invite: "" } });

    // The algebra followed underneath, as evidence for the model; a checker that fails just leaves it out.
    const results = await checkSteps(read_.map((l) => l.sympy)).catch(() => []);
    const lines: WorkLine[] = read_.map((l, i) => {
      const r = results[i];
      const follows = r && r.status !== "given" ? FOLLOWS[r.status] : undefined;
      return { ...l, ...(follows ? { follows } : {}), ...(r?.note ? { note: r.note } : {}) };
    });
    await store.update(cardId, { stage: "writing", work: { problem, lines, opening: "", ideas: [], invite: "" } });

    const card = (await store.findItem(cardId)) as CardItem;
    const told = await readerNotes(store, card);
    const evidence = (l: WorkLine) => (l.follows === "yes" ? "   [follows]" : l.follows === "no" ? `   [doesn't follow${l.note ? `: ${l.note}` : ""}]` : l.note ? `   [${l.note}]` : "");
    const said = await chatJson<{ opening?: unknown; ideas?: unknown; invite?: unknown }>(config.llm, [
      { role: "system", content: LOOK },
      {
        role: "user",
        content: [problem ? `What they're working on: ${problem}` : "", `Their work:\n${lines.map((l, i) => `${i + 1}. ${l.latex}${evidence(l)}`).join("\n")}`, told]
          .filter(Boolean)
          .join("\n\n"),
      },
    ]);
    const ideas: WorkIdea[] = (Array.isArray(said.ideas) ? said.ideas : [])
      .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
      .map((x) => ({
        name: str(x.name).slice(0, 120),
        lines: (Array.isArray(x.lines) ? x.lines : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= lines.length),
        what: str(x.what).slice(0, 400),
        note: str(x.note).slice(0, 600),
        ...(x.differs === true ? { differs: true } : {}),
        ...(str(x.origin) ? { origin: str(x.origin).slice(0, 200) } : {}),
      }))
      .filter((x) => x.name)
      .slice(0, 4);
    if (!ideas.length && !str(said.opening)) console.warn("looking at work: nothing said; the reply had:", JSON.stringify(said).slice(0, 600));
    await store.update(cardId, {
      stage: "done",
      work: { problem, lines, opening: str(said.opening).slice(0, 600), ideas, invite: str(said.invite).slice(0, 300) },
    });
  });
}
