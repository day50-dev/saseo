// The librarian's loop for one card: read the region, go fish, write a descending
// explanation from what was found, then check that it doesn't climb.
import type { CardItem, FoundSource, Item, Sem } from "../shared/canvas.ts";
import { SEARCHER_IDS } from "../shared/providers.ts";
import { findItem, update } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chatJson, decideYesNo, type Message, systemOneConfigured } from "./llm.ts";
import { runSearch } from "./providers.ts";

const IDENTIFY = `You help a curious, intelligent reader who is not a specialist. They selected part of an image because they don't understand it.
The first image is the whole page with a red rectangle around their selection. The second image is the selection enlarged.
Return JSON only, no prose:
{"transcription": "the exact text or math inside the rectangle (math as LaTeX)",
 "subject": "short name of the concept they are asking about, 2-6 words, as a reader would say it",
 "topic": "what the whole page is about, a few words",
 "searchQuery": "a short web search query, 2-6 plain words, for BEGINNER material (intro lecture notes, textbook chapters, videos) on the most general idea behind the subject. Never the paper's title, its notation, or terms specific to this page."}`;

const EXPLAIN = `You are a research librarian with unlimited time, helping a curious, intelligent reader who is not a specialist in this field.
Your explanation will be drawn as a diagram, not printed as paragraphs, so you return its STRUCTURE: short pieces and how they connect.
Rules:
- Descend, never climb. Use ideas MORE general and familiar than the subject. Never define it in terms more specialized than itself. If a technical term is unavoidable, it must be more basic than the subject, and you gloss it in plain words.
- Start with why: the question or problem the idea answers, so it doesn't feel arbitrary.
- Be faithful. Don't invent facts. Where a numbered source supports a claim, cite it as [n]. Standard background needs no citation.
- Every piece is short: one sentence, at most about 20 words. Plain text. Math as plain text, not LaTeX.
Return JSON only, no prose:
{"why": ["2 to 4 steps forming a chain: the problem, then each step following from the one before"],
 "what": {"gist": "one sentence: what it is, in familiar terms", "details": ["0 to 3 further facts about it"]},
 "parts": [{"symbol": "a piece of the formula or name, copied as written", "meaning": "what that piece is, 2-6 words", "note": "one short gloss"}],
 "together": "if there are parts: what they add up to, one sentence; otherwise empty",
 "here": ["1 to 3 steps: how it is used on this page specifically"],
 "name": "what the words of its name mean, or an empty string if that isn't illuminating"}
Use "parts" only when the subject is a formula or a compound whose pieces each mean something (2 to 5 parts); otherwise return [].`;

const CLIMB_QUESTION =
  "Does this explanation rely on terms or ideas that are more specialized or obscure than its subject, without explaining them in plain words?";

async function ancestry(card: CardItem): Promise<{ path: string[]; topic?: string; root?: CardItem }> {
  const path: string[] = [];
  let topic: string | undefined;
  let root: CardItem | undefined;
  let cur: Item | undefined = await findItem(card.parentId);
  while (cur?.kind === "card") {
    if (cur.subject) path.unshift(cur.subject);
    topic ??= cur.topic;
    root = cur;
    cur = await findItem(cur.parentId);
  }
  return { path, topic: topic ?? root?.topic, root };
}

function mergeHits(results: Awaited<ReturnType<typeof runSearch>>, max = 6): FoundSource[] {
  const lists = Object.entries(results)
    .filter(([, r]) => r?.ok)
    .map(([id, r]) => r!.hits.map((h) => ({ ...h, searcher: id })));
  const seen = new Set<string>();
  const out: FoundSource[] = [];
  // Round-robin so one searcher can't crowd out the others.
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const h = l[i];
      if (!h || out.length >= max) continue;
      // The same document often comes back under several URLs (abs/html/pdf); match on title too.
      const key = h.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      const title = h.title.trim().toLowerCase();
      if (seen.has(key) || (title && seen.has(`t:${title}`))) continue;
      seen.add(key);
      if (title) seen.add(`t:${title}`);
      out.push({ n: out.length + 1, url: h.url, title: h.title, snippet: h.snippet.slice(0, 600), searcher: h.searcher });
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map(str).filter(Boolean).slice(0, max);

/** Accepts whatever the model returned and keeps only well-formed pieces of a Sem. */
function cleanSem(raw: Record<string, unknown>): Sem {
  const what = (raw.what ?? {}) as Record<string, unknown>;
  const parts = (Array.isArray(raw.parts) ? raw.parts : [])
    .map((p) => p as Record<string, unknown>)
    .map((p) => ({ symbol: str(p.symbol), meaning: str(p.meaning), note: str(p.note) }))
    .filter((p) => p.symbol && p.meaning)
    .slice(0, 5);
  return {
    why: strs(raw.why, 4),
    what: { gist: typeof raw.what === "string" ? str(raw.what) : str(what.gist), details: strs(what.details, 3) },
    parts: parts.length >= 2 ? parts : [],
    together: parts.length >= 2 ? str(raw.together) : "",
    here: strs(raw.here ?? raw.how, 3),
    name: str(raw.name),
  };
}

const semText = (s: Sem) =>
  [...s.why, s.what.gist, ...s.what.details, ...s.parts.map((p) => `${p.symbol}: ${p.meaning}, ${p.note}`), s.together, ...s.here]
    .filter(Boolean)
    .join("\n");

async function write(card: CardItem, subject: string, quoted: string, topic: string | undefined, path: string[], sources: FoundSource[]) {
  const config = await loadConfig();
  const lines = [
    `Subject: ${subject}`,
    `What the reader selected: ${quoted}`,
    topic ? `The page is about: ${topic}` : "",
    path.length
      ? `The reader got here by asking about: ${path.join(" → ")} → ${subject}. They don't know these yet, so don't lean on them.`
      : "",
    sources.length
      ? `Sources found:\n${sources.map((s) => `[${s.n}] ${s.title} (${s.url})\n${s.snippet}`).join("\n\n")}`
      : "No sources were found; rely on standard knowledge.",
  ].filter(Boolean);
  const messages: Message[] = [
    { role: "system", content: EXPLAIN },
    { role: "user", content: lines.join("\n\n") },
  ];
  let sem = cleanSem(await chatJson<Record<string, unknown>>(config.llm, messages));
  if (!sem.why.length && !sem.what.gist) throw new Error("The model's answer had no why and no what");
  let climb: number | undefined;
  let rewritten = false;

  if (systemOneConfigured(config.systemOne)) {
    await update(card.id, { stage: "checking", sem, sources });
    const check = (s: Sem) => decideYesNo(config.systemOne, { subject, explanation: semText(s) }, CLIMB_QUESTION);
    try {
      climb = await check(sem);
      if (climb >= 0.5) {
        messages.push(
          { role: "assistant", content: JSON.stringify(sem) },
          {
            role: "user",
            content:
              "A check found this climbs: it leans on terms more specialized than the subject. Rewrite it using only more familiar ideas, glossing anything technical in everyday words. Same JSON shape.",
          },
        );
        const second = cleanSem(await chatJson<Record<string, unknown>>(config.llm, messages));
        const secondClimb = await check(second);
        rewritten = true;
        // Keep whichever version the check judged to climb less.
        if (secondClimb < climb) {
          sem = second;
          climb = secondClimb;
        }
      }
    } catch {
      // The check is advisory; a failure leaves the draft as written.
    }
  }
  await update(card.id, { stage: "done", sem, sources, climb, rewritten });
}

async function search(query: string): Promise<FoundSource[]> {
  const config = await loadConfig();
  const enabled = SEARCHER_IDS.filter((id) => config.searchers[id].enabled);
  if (!enabled.length) return [];
  return mergeHits(await runSearch(config, query, enabled, 4));
}

async function guard(cardId: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    await update(cardId, { stage: "failed", error: err instanceof Error ? err.message : String(err) });
  }
}

/** For a rectangle on an image: `marked` is the whole page with the rectangle drawn, `crop` the region. */
export function explainRegion(cardId: string, images: { marked: string; crop: string }) {
  return guard(cardId, async () => {
    const config = await loadConfig();
    const content = [
      { type: "text" as const, text: "Here is the page and the part I selected." },
      { type: "image_url" as const, image_url: { url: images.marked } },
      { type: "image_url" as const, image_url: { url: images.crop } },
    ];
    const id = await chatJson<{ transcription?: string; subject?: string; topic?: string; searchQuery?: string }>(
      config.llm,
      [
        { role: "system", content: IDENTIFY },
        { role: "user", content },
      ],
    );
    const subject = id.subject?.trim() || "this";
    await update(cardId, { stage: "searching", subject, transcription: id.transcription, topic: id.topic });
    // Ask for introductions explicitly; left alone, searches on a slide's words find the paper itself.
    const sources = await search(`${id.searchQuery?.trim() || subject} introduction`);
    await update(cardId, { stage: "writing", sources });
    const card = (await findItem(cardId)) as CardItem;
    await write(card, subject, id.transcription ?? subject, id.topic, [], sources);
  });
}

/** For words the learner selected inside another card: explain them one level further down. */
export function explainSelection(cardId: string) {
  return guard(cardId, async () => {
    const card = (await findItem(cardId)) as CardItem;
    const selection = card.selection ?? "";
    const { path, topic } = await ancestry(card);
    const subject = selection;
    await update(cardId, { stage: "searching", subject, topic });
    // Search for the plain concept, not "concept + page topic": adding the topic pulls results
    // back toward the specialist material, which is the climb the descent is meant to avoid.
    const sources = await search(`${selection} explained introduction`);
    await update(cardId, { stage: "writing", sources });
    await write(card, subject, selection, topic, path, sources);
  });
}
