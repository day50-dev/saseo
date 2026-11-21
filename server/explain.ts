// The librarian's loop for one card: read the region, go fish, write a descending
// explanation from what was found, then check that it doesn't climb.
import type { CardItem, Facets, FoundSource, Item } from "../shared/canvas.ts";
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
 "searchQuery": "a web search query likely to find introductory explanations, lecture notes or videos about the subject"}`;

const EXPLAIN = `You are a research librarian with unlimited time, helping a curious, intelligent reader who is not a specialist in this field.
Rules:
- Descend, never climb. Explain with ideas MORE general and familiar than the subject. Never define it in terms more specialized than itself. If a technical term is unavoidable, it must be more basic than the subject, and you gloss it in plain words.
- Start with why: the question or problem the idea answers and what goes wrong without it, so it doesn't feel arbitrary.
- Be faithful. Don't invent facts. Where a numbered source supports a claim, cite it as [n]. Standard background needs no citation.
- Be short: 2 to 4 sentences per field. Plain text. Write math as plain text, not LaTeX.
Return JSON only, no prose:
{"why": "the question it answers / what breaks without it",
 "what": "what it is, in familiar terms",
 "how": "how it is used on this page specifically",
 "name": "what the words of its name mean, or an empty string if that isn't illuminating"}`;

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

function cleanFacets(f: Partial<Facets>): Facets {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { why: s(f.why), what: s(f.what), how: s(f.how), name: s(f.name) };
}

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
  let facets = cleanFacets(await chatJson<Partial<Facets>>(config.llm, messages));
  let climb: number | undefined;
  let rewritten = false;

  if (systemOneConfigured(config.systemOne)) {
    await update(card.id, { stage: "checking", facets, sources });
    const check = (f: Facets) =>
      decideYesNo(config.systemOne, { subject, explanation: `${f.why}\n${f.what}\n${f.how}` }, CLIMB_QUESTION);
    try {
      climb = await check(facets);
      if (climb >= 0.5) {
        messages.push(
          { role: "assistant", content: JSON.stringify(facets) },
          {
            role: "user",
            content:
              "A check found this climbs: it leans on terms more specialized than the subject. Rewrite it using only more familiar ideas, glossing anything technical. Same JSON shape.",
          },
        );
        facets = cleanFacets(await chatJson<Partial<Facets>>(config.llm, messages));
        rewritten = true;
        climb = await check(facets);
      }
    } catch {
      // The check is advisory; a failure leaves the draft as written.
    }
  }
  await update(card.id, { stage: "done", facets, sources, climb, rewritten });
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
    const sources = await search(id.searchQuery?.trim() || `${subject} ${id.topic ?? ""}`.trim());
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
