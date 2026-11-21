// The librarian's loop for one card: read the region, go fish, write a descending
// explanation from what was found, then check that it doesn't climb.
import type { CardItem, FoundSource, Item, Register, RegisterNote, Sem } from "../shared/canvas.ts";
import { SEARCHER_IDS } from "../shared/providers.ts";
import type { CanvasStore } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chat, chatJson, decideChoice, decideYesNo, type Message, systemOneConfigured } from "./llm.ts";
import { runSearch } from "./providers.ts";

const IDENTIFY = `You help a curious, intelligent reader who is not a specialist. They selected part of an image because they don't understand it.
The first image is the whole page with a red rectangle around their selection. The second image is the selection enlarged.
Return JSON only, no prose:
{"transcription": "the exact text or math inside the rectangle (math as LaTeX)",
 "subject": "short name of the concept they are asking about, 2-6 words, as a reader would say it",
 "topic": "what the whole page is about, a few words",
 "pageText": "the full text of the WHOLE page in reading order (math as LaTeX), so later steps know the context",
 "terms": [{"text": "a word, phrase or symbol INSIDE the rectangle, copied as written",
            "register": "term (a technical term with a strict definition) | idiom (an insider phrase or move with a precise meaning rarely spelled out) | casual (everyday words used loosely) | notation (ONLY a symbol or formula visibly used loosely: in quote marks, with ≈ or "morally"; a precise symbol such as L^1(R^2) or a defined function is a term)",
            "means": "for casual words or notation: what is actually meant; for a term or idiom: a one-line plain gloss",
            "field": "for a term borrowed from another area, that area; otherwise empty"}],
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
 "name": "what the words of its name mean, or an empty string if that isn't illuminating",
 "terms": ["every technical term of art you used above, copied exactly as you wrote it"],
 "standIns": [{"phrase": "an everyday phrase you used above in place of a technical term, copied exactly", "concept": "the technical term it stands for"}]}
Mark the register honestly: a reader can't otherwise tell your strict terms from your plain-language stand-ins.
Use "parts" only when the subject is a formula or a compound whose pieces each mean something (2 to 5 parts); otherwise return [].`;

const CLIMB_QUESTION =
  "Does this explanation rely on terms or ideas that are more specialized or obscure than its subject, without explaining them in plain words?";

async function ancestry(store: CanvasStore, card: CardItem): Promise<{ path: string[]; topic?: string; root?: CardItem }> {
  const path: string[] = [];
  let topic: string | undefined;
  let root: CardItem | undefined;
  let cur: Item | undefined = await store.findItem(card.parentId);
  while (cur?.kind === "card") {
    if (cur.subject) path.unshift(cur.subject);
    topic ??= cur.topic;
    root = cur;
    cur = await store.findItem(cur.parentId);
  }
  return { path, topic: topic ?? root?.topic, root };
}

/** A card's explanation as plain text: the structure for newer cards, paragraphs for older ones. */
function cardText(c: CardItem): string {
  if (c.sem) {
    const standIns = (c.sem.standIns ?? []).map((s) => `"${s.phrase}" stands for ${s.concept}`);
    return [semText(c.sem), standIns.length ? `Plain-language stand-ins used: ${standIns.join("; ")}` : ""].filter(Boolean).join("\n");
  }
  if (c.facets) return [c.facets.why, c.facets.what, c.facets.how].filter(Boolean).join("\n");
  return "";
}

/**
 * Everything the librarian knows about how the reader got to this card: what they boxed on the
 * page, every card on the way down with its gist, and the full explanation they selected from.
 */
async function trail(store: CanvasStore, card: CardItem): Promise<string> {
  const chain: CardItem[] = [];
  let cur: Item | undefined = await store.findItem(card.parentId);
  while (cur?.kind === "card") {
    chain.unshift(cur);
    cur = await store.findItem(cur.parentId);
  }
  if (!chain.length) return "";
  const root = chain[0];
  const parent = chain[chain.length - 1];
  const lines = [
    `The reader boxed this on a page${root.topic ? ` about ${root.topic}` : ""}${root.transcription ? `: ${root.transcription}` : ""}`,
    root.pageText ? `The whole page reads:\n${root.pageText}` : "",
    `Then, step by step, they asked about:`,
    ...chain.map((c, i) => `${i + 1}. ${c.subject ?? c.selection ?? "?"}${c.sem?.what.gist ? `: ${c.sem.what.gist}` : ""}`),
    `The full explanation of "${parent.subject ?? "the previous card"}" that they selected words from:`,
    cardText(parent),
  ];
  return lines.filter(Boolean).join("\n");
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
    terms: strs(raw.terms, 12),
    standIns: (Array.isArray(raw.standIns) ? raw.standIns : [])
      .map((s) => s as Record<string, unknown>)
      .map((s) => ({ phrase: str(s.phrase), concept: str(s.concept) }))
      .filter((s) => s.phrase && s.concept)
      .slice(0, 8),
  };
}

function cleanTerms(raw: unknown): RegisterNote[] {
  const out: RegisterNote[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const t = item as Record<string, unknown>;
    // Models sometimes echo the option list ("term (a technical term…)"); keep the first word.
    const register = str(t.register).split(/[\s(|]/)[0];
    const text = str(t.text);
    if (!text || !isRegister(register)) continue;
    out.push({ text, register, means: str(t.means), field: str(t.field) || undefined });
  }
  return out.slice(0, 10);
}

const semText = (s: Sem) =>
  [...s.why, s.what.gist, ...s.what.details, ...s.parts.map((p) => `${p.symbol}: ${p.meaning}, ${p.note}`), s.together, ...s.here]
    .filter(Boolean)
    .join("\n");

async function write(
  store: CanvasStore,
  card: CardItem,
  subject: string,
  quoted: string,
  topic: string | undefined,
  path: string[],
  sources: FoundSource[],
  context = "",
) {
  const config = await loadConfig();
  const lines = [
    `Subject: ${subject}`,
    `What the reader selected: ${quoted}`,
    context ? `How they got here:\n${context}` : "",
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
    await store.update(card.id, { stage: "checking", sem, sources });
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
  await store.update(card.id, { stage: "done", sem, sources, climb, rewritten });
}

async function search(query: string): Promise<FoundSource[]> {
  const config = await loadConfig();
  const enabled = SEARCHER_IDS.filter((id) => config.searchers[id].enabled);
  if (!enabled.length) return [];
  return mergeHits(await runSearch(config, query, enabled, 4));
}

async function guard(store: CanvasStore, cardId: string, run: () => Promise<void>) {
  const limit = (await loadConfig()).llm.timeoutSeconds;
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || /aborted due to timeout/.test(message));
    await store.update(cardId, {
      stage: "failed",
      error: timedOut
        ? `The language model didn't answer within ${limit} seconds. It may be busy with another card; retry, or raise the timeout in Settings.`
        : message,
    });
  }
}

/** For a rectangle on an image: `marked` is the whole page with the rectangle drawn, `crop` the region. */
export function explainRegion(store: CanvasStore, cardId: string, images: { marked: string; crop: string }) {
  return guard(store, cardId, async () => {
    const config = await loadConfig();
    const content = [
      { type: "text" as const, text: "Here is the page and the part I selected." },
      { type: "image_url" as const, image_url: { url: images.marked } },
      { type: "image_url" as const, image_url: { url: images.crop } },
    ];
    const id = await chatJson<{
      transcription?: string;
      subject?: string;
      topic?: string;
      searchQuery?: string;
      pageText?: string;
      terms?: unknown;
    }>(
      config.llm,
      [
        { role: "system", content: IDENTIFY },
        { role: "user", content },
      ],
    );
    const subject = id.subject?.trim() || "this";
    const pageText = str(id.pageText).slice(0, 6000) || undefined;
    const terms = cleanTerms(id.terms);
    await store.update(cardId, { stage: "searching", subject, transcription: id.transcription, topic: id.topic, pageText, terms });
    // Ask for introductions explicitly; left alone, searches on a slide's words find the paper itself.
    const sources = await search(`${id.searchQuery?.trim() || subject} introduction`);
    await store.update(cardId, { stage: "writing", sources });
    const card = (await store.findItem(cardId)) as CardItem;
    const context = [
      pageText ? `The whole page reads:\n${pageText}` : "",
      terms.length
        ? `Register of the words in the selection (strict terms must be explained as strict terms, informal words for what they point at):\n${terms
            .map((t) => `- "${t.text}": ${t.register}${t.means ? ` (${t.means})` : ""}`)
            .join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    await write(store, card, subject, id.transcription ?? subject, id.topic, [], sources, context);
  });
}

const RESOLVE = `A reader selected some words inside an explanation because they want to know more.
Work out what idea those words refer to IN THAT SENTENCE. Explanations often use everyday stand-ins
("an invisible push", "spread-out flow") for a real concept, and searching the literal words finds
nothing useful. Name the real concept the way an introductory textbook would title it.

Also judge the REGISTER of the selected words as used in that sentence. Mathematical writing switches
without warning between strict terms of art and casual description, and both look like plain English:
- "term": a technical term with a strict definition (e.g. "energy space", "well-posed", "Coulomb gauge")
- "idiom": a standard insider phrase or move with a precise meaning rarely spelled out (e.g. "closes the bootstrap")
- "casual": everyday words used loosely, often pointing at something precise (e.g. "+ better", "the worst term", "rougher")
- "notation": ONLY a symbol or formula visibly used loosely (in quote marks, with ≈, "morally"), meaning "roughly this"; a precise symbol (L^1(R^2), a defined function) is a "term"
Return JSON only, no prose:
{"concept": "the standard name of the idea, 2-6 words",
 "searchQuery": "2-6 plain words for BEGINNER material (intro notes, textbook chapters, videos) on that concept, without terms specific to the page",
 "register": "term" | "idiom" | "casual" | "notation",
 "means": "for casual words or notation: what is actually meant, precisely, in one sentence; for a term or idiom: a one-line plain gloss",
 "field": "for a term borrowed from another area of mathematics or physics, that area; otherwise empty"}`;

const REGISTER_QUESTION =
  "Judging as a researcher steeped in this field would, using the whole page and the chain of explanations in the state: in the sentence, are the selected words a strict technical term, an insider idiom, casual everyday language, or loosely used notation?";

const REGISTER_CRITERIA: Record<Register, string> = {
  term: "A technical term with a strict, formal definition.",
  idiom: "A standard insider phrase or proof move with a precise meaning that is rarely spelled out.",
  casual: "Everyday words used loosely or descriptively, not a defined term.",
  notation: "A symbol or formula visibly used loosely, such as inside quote marks or with ≈, meaning approximately. A precise symbol is a term.",
};

const isRegister = (v: unknown): v is Register => typeof v === "string" && v in REGISTER_CRITERIA;

/** What the selected words name, as a concept and a beginner search; null if the model can't say. */
async function resolveSelection(
  selection: string,
  sentence: string | undefined,
  context: string,
): Promise<{ concept: string; searchQuery: string; register?: Omit<RegisterNote, "text"> } | null> {
  const config = await loadConfig();
  try {
    const r = await chatJson<{ concept?: string; searchQuery?: string; register?: string; means?: string; field?: string }>(config.llm, [
      { role: "system", content: RESOLVE },
      {
        role: "user",
        content: [
          `Selected words: ${selection}`,
          sentence ? `The sentence they are in: ${sentence}` : "",
          context ? `Everything known about where that sentence comes from:\n${context}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ]);
    const concept = str(r.concept);
    const searchQuery = str(r.searchQuery);
    if (!concept || !searchQuery) return null;
    let register = isRegister(r.register) ? r.register : undefined;

    // Register is a typed choice, which is what the fast decision model is for. Its answer wins
    // when it is confident; the LLM's judgement is the fallback.
    if (systemOneConfigured(config.systemOne)) {
      try {
        const d = await decideChoice(
          config.systemOne,
          { selected: selection, sentence: sentence ?? "", context },
          REGISTER_QUESTION,
          REGISTER_CRITERIA,
        );
        if (isRegister(d.choice) && d.confidence >= 0.6) register = d.choice;
      } catch {
        // Advisory: keep the LLM's answer.
      }
    }
    return {
      concept,
      searchQuery,
      register: register ? { register, means: str(r.means), field: str(r.field) || undefined } : undefined,
    };
  } catch {
    return null;
  }
}

const REGISTER_GUIDANCE: Record<Register, string> = {
  term:
    "The selected words are a TERM OF ART with a strict definition. Give that actual definition, reached by descending from familiar ideas, and don't blur it into a loose analogy.",
  idiom:
    "The selected words are an INSIDER IDIOM. Say what the standard move or phrase means precisely, and why insiders say it this way.",
  casual:
    "The selected words are INFORMAL: the author is speaking loosely. Explain what they are pointing at, precisely, and make clear the words themselves aren't a defined term.",
  notation:
    "The selected notation is used LOOSELY (for example in quote marks). Explain the rough statement and what the exact one would add.",
};

/** For words the learner selected inside another card: explain them one level further down. */
export function explainSelection(store: CanvasStore, cardId: string) {
  return guard(store, cardId, async () => {
    const card = (await store.findItem(cardId)) as CardItem;
    const selection = card.selection ?? "";
    const { path, topic } = await ancestry(store, card);
    const context = await trail(store, card);

    // First work out what the words mean where they were selected: the literal words of a plain
    // gloss ("invisible push") find nothing, while the page topic pulls the search back toward the
    // specialist material. Search for the concept itself, at beginner level.
    await store.update(cardId, { stage: "reading" });
    const resolved = await resolveSelection(selection, card.context, context);
    const subject = resolved?.concept ?? selection;
    const quoted = card.context ? `“${selection}” in: ${card.context}` : selection;
    const register: RegisterNote | undefined = resolved?.register ? { text: selection, ...resolved.register } : undefined;
    await store.update(cardId, { stage: "searching", subject, topic, transcription: card.context ? quoted : undefined, register });

    const sources = await search(resolved ? `${resolved.searchQuery} introduction` : `${selection} explained introduction`);
    await store.update(cardId, { stage: "writing", sources });
    const guidance = register ? `${REGISTER_GUIDANCE[register.register]}${register.means ? ` (${register.means})` : ""}` : "";
    await write(store, card, subject, quoted, topic, path, sources, [context, guidance].filter(Boolean).join("\n\n"));
  });
}

// ---- Relations: the learner asks how two things are related ----

const RELATE = `A reader dragged a connection between two things they are studying and asked how they are related.
They are not claiming they ARE related; they want to find out.
Return JSON only, no prose:
{"relation": "a short name for how they relate, 3-8 words, or 'only loosely related' if that's the truth",
 "searchQuery": "2-6 plain words for BEGINNER material on the relationship between the two ideas, without terms specific to the page"}`;

const RELATION_GUIDANCE = `The reader asked how the two things below are related; they are not claiming they are. Explain the ACTUAL relationship:
- "why": the chain that links the first to the second, step by step.
- "what": the relationship in one sentence (gist). If they are only loosely related or not related at all, say so plainly here.
- "parts": exactly two entries, the first thing then the second; "symbol" is its name, "meaning" its role in the relationship.
- "together": the connecting idea that joins them.
- "here": where on this page the link matters, if it does.`;

/** One side of a relation, with everything known about where it came from. */
async function describe(store: CanvasStore, id: string): Promise<{ name: string; text: string }> {
  const item = await store.findItem(id);
  if (item?.kind !== "card") return { name: "?", text: "" };
  const name = item.subject ?? item.selection ?? "this";
  const lines = [
    `"${name}"`,
    item.transcription ? `Selected text: ${item.transcription}` : "",
    item.pageText ? `The page it came from reads:\n${item.pageText}` : "",
    await trail(store, item),
    `Its explanation:\n${cardText(item)}`,
  ];
  return { name, text: lines.filter(Boolean).join("\n") };
}

export function explainRelation(store: CanvasStore, cardId: string) {
  return guard(store, cardId, async () => {
    const card = (await store.findItem(cardId)) as CardItem;
    const [aId, bId] = card.relates!;
    const [a, b] = await Promise.all([describe(store, aId), describe(store, bId)]);
    const config = await loadConfig();
    const both = `FIRST: ${a.text}\n\nSECOND: ${b.text}`;

    await store.update(cardId, { stage: "reading" });
    let relation = `${a.name} and ${b.name}`;
    let query = `${a.name} ${b.name} relationship`;
    try {
      const r = await chatJson<{ relation?: string; searchQuery?: string }>(config.llm, [
        { role: "system", content: RELATE },
        { role: "user", content: both },
      ]);
      relation = str(r.relation) || relation;
      query = str(r.searchQuery) || query;
    } catch {
      // Fall back to searching the two names together.
    }
    const subject = relation;
    await store.update(cardId, { stage: "searching", subject });
    const sources = await search(`${query} introduction`);
    await store.update(cardId, { stage: "writing", sources });
    await write(store, card, subject, `How are "${a.name}" and "${b.name}" related?`, undefined, [], sources, `${RELATION_GUIDANCE}\n\n${both}`);
  });
}

// ---- Conversation held at a card ----

const CHAT = `You are a research librarian with unlimited time, talking with a curious, intelligent reader who is not a specialist.
The conversation is about ONE card on their canvas; everything known about it follows.
Rules:
- Descend, never climb: answer with ideas more familiar than what is asked about, and gloss any technical term you must use in plain words.
- Say plainly when a word is a strict technical term and when it is being used loosely.
- Be faithful. Where one of the card's numbered sources supports a claim, cite it as [n]. If you don't know, say so.
- Be brief: 1 to 4 sentences unless the reader asks for more. Plain text, math as plain text.`;

/** Answers the learner's latest message in a card's conversation, with everything known about the card. */
export async function chatAbout(store: CanvasStore, cardId: string) {
  const config = await loadConfig();
  const card = (await store.findItem(cardId)) as CardItem;
  try {
    const about = await describe(store, cardId);
    const sources = (card.sources ?? []).map((s) => `[${s.n}] ${s.title} (${s.url})\n${s.snippet}`).join("\n\n");
    const history: Message[] = (card.chat ?? []).slice(-20).map((m) => ({ role: m.role, content: m.text }));
    const reply = await chat(config.llm, [
      { role: "system", content: `${CHAT}\n\nThe card:\n${about.text}${sources ? `\n\nIts sources:\n${sources}` : ""}` },
      ...history,
    ]);
    await store.record({ type: "chat", id: cardId, message: { role: "assistant", text: reply.trim(), at: new Date().toISOString() } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || /aborted due to timeout/.test(message));
    const text = timedOut
      ? `(No answer within ${config.llm.timeoutSeconds} seconds. Ask again, or raise the timeout in Settings.)`
      : `(Couldn't answer: ${message})`;
    await store.record({ type: "chat", id: cardId, message: { role: "assistant", text, at: new Date().toISOString() } });
  } finally {
    await store.update(cardId, { chatPending: false });
  }
}
