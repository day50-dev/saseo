// Checking someone's own working: a box drawn round handwritten (or typed) steps on a photo. The
// model only reads it, line by line, mistakes and all; SymPy (check_steps.py) decides whether each
// step follows from the one before; then the model says what went wrong at the first step that
// doesn't, and what to do there instead, without doing the rest for them.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CardItem, WorkCheck, WorkStep } from "../shared/canvas.ts";
import { unescapeTwice } from "../shared/tex.ts";
import type { CanvasStore } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { guard, readerNotes } from "./explain.ts";
import { chatJson } from "./llm.ts";

const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "check_steps.py");

const READ_WORK = `You are reading someone's own written working: homework, practice or notes, often handwritten. You are shown the
whole photo with a box drawn on it, then the boxed part enlarged. Transcribe the working in the box, line by line, EXACTLY as
written, mistakes included: never correct, skip or tidy a step, and never add steps of your own. Their mistakes are the point.
Return JSON only:
{"problem": "what they are working out, in words, if it's written or plain from the working (else \\"\\")",
 "steps": [{"latex": "the line as written, in LaTeX", "sympy": "the same line in SymPy syntax"}]}
SymPy syntax: * for multiplication and ** for powers (write 2*x, x**2), sqrt(), exp(), log(), sin(), cos(), tan(), pi, E, I.
- A line that is an equation: "lhs = rhs", one "=".
- A line that carries on a chain ("= 2x + 4", or the next part of "a = b = c"): just that expression, one step per part.
- A derivative: Derivative(f, x). An integral: Integral(f, x), or Integral(f, (x, a, b)) with limits. A limit: Limit(f, x, a).
- A line of words, a label ("a)", "Step 2"), a crossed-out line or a diagram: "sympy": "" (keep words in latex as \\text{...}).
- A number with units: leave the units out of sympy.
Use the same letters they use. The question itself ("Find f'(x) if…", "Solve for x") goes in "problem", not in the steps;
the steps are only their working.`;

const SAY = `You are a patient tutor looking over someone's working with them. Each step has already been checked by a computer
algebra system (SymPy): "ok" means it follows from the line before, "wrong" means it plainly does not, "unchecked" means the
system couldn't tell (trust your own reading there, carefully). Trust the system's "ok" and "wrong".
Return JSON only:
{"verdict": "one or two plain sentences: how the working went. If a step is wrong, say which line (number) and that the rest follows from it.
             If every step is ok, say so, and whether the last line actually answers what was asked.",
 "why": "if a step is wrong: what went wrong at THAT step, in 1 to 3 plain sentences, about the move they made (a sign, a term dropped,
         a rule misapplied), not a lecture. Else \\"\\".",
 "hint": "if a step is wrong: what to do at that step instead, in one sentence, without working the rest out for them. Else \\"\\"."}
Write math inline as LaTeX between \\( and \\). Be direct and kind; never say "great job" or similar.`;

/** What SymPy made of each step, in order. */
export function checkSteps(steps: string[]): Promise<{ status: WorkStep["status"]; note?: string }[]> {
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-I", CHECKER], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) return reject(new Error(`Couldn't check the steps: ${err.message.split("\n")[0]}`));
      try {
        resolve((JSON.parse(String(out)) as { results: { status: WorkStep["status"]; note?: string }[] }).results);
      } catch {
        reject(new Error("Couldn't check the steps: the checker's answer didn't parse"));
      }
    });
    child.stdin?.end(JSON.stringify({ steps }));
  });
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Reads the working in a box, checks each step, and says what went wrong first. */
export function checkWork(store: CanvasStore, cardId: string, images: { marked: string; crop: string }) {
  return guard(store, cardId, async () => {
    const config = await loadConfig();
    await store.update(cardId, { stage: "reading" });
    const read = await chatJson<{ problem?: unknown; steps?: unknown }>(config.llm, [
      { role: "system", content: READ_WORK },
      {
        role: "user",
        content: [
          { type: "text", text: "Here is the photo, and the working I boxed." },
          { type: "image_url", image_url: { url: images.marked } },
          { type: "image_url", image_url: { url: images.crop } },
        ],
      },
    ]);
    const lines = (Array.isArray(read.steps) ? read.steps : [])
      .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
      .map((s) => ({ latex: unescapeTwice(str(s.latex)).slice(0, 600), sympy: str(s.sympy).slice(0, 600) }))
      .filter((s) => s.latex || s.sympy)
      .slice(0, 40);
    if (!lines.length) throw new Error("Couldn't find any working in the box. Try a box round the lines of working, in a sharper photo.");
    const problem = str(read.problem).slice(0, 400);
    await store.update(cardId, {
      stage: "checking",
      subject: problem || "Your working",
      work: { problem, steps: lines.map((l) => ({ ...l, status: "unchecked" as const })), verdict: "" },
    });

    const results = await checkSteps(lines.map((l) => l.sympy));
    const steps: WorkStep[] = lines.map((l, i) => ({ ...l, status: results[i]?.status ?? "unchecked", ...(results[i]?.note ? { note: results[i].note } : {}) }));
    const wrong = steps.findIndex((s) => s.status === "wrong");
    const work: WorkCheck = { problem, steps, ...(wrong >= 0 ? { wrongAt: wrong } : {}), verdict: "" };
    await store.update(cardId, { stage: "writing", work });

    const card = (await store.findItem(cardId)) as CardItem;
    const told = await readerNotes(store, card);
    const said = await chatJson<{ verdict?: unknown; why?: unknown; hint?: unknown }>(config.llm, [
      { role: "system", content: SAY },
      {
        role: "user",
        content: [
          problem ? `What they're working out: ${problem}` : "",
          `Their working, checked:\n${steps.map((s, i) => `${i + 1}. ${s.latex}   [${s.status}${s.note ? `: ${s.note}` : ""}]`).join("\n")}`,
          wrong >= 0 ? `The first step that doesn't follow is line ${wrong + 1}.` : "No step was found wrong.",
          told,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ]);
    await store.update(cardId, {
      stage: "done",
      work: {
        ...work,
        verdict: str(said.verdict).slice(0, 600) || (wrong >= 0 ? `Line ${wrong + 1} doesn't follow from the line before.` : "Every step that could be checked follows."),
        ...(wrong >= 0 && str(said.why) ? { why: str(said.why).slice(0, 800) } : {}),
        ...(wrong >= 0 && str(said.hint) ? { hint: str(said.hint).slice(0, 400) } : {}),
      },
    });
  });
}
