// Goals: what the learner is after, and what they had to go and find out on the way. Each card that
// finishes is placed under one: the goal it works toward, a new subgoal (something that goal turned
// out to need), or a detour (curiosity off to the side). The first card on a canvas starts its first
// goal. The learner can add, reword, finish and clear goals; the librarian only guesses.
import type { CardItem, Goal, Item } from "../shared/canvas.ts";
import { type CanvasStore, newId, onCardDone } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chatJson } from "./llm.ts";

const PLACE = `You keep track of what a learner is after while they study on a canvas of cards.
Goals form a tree. A "goal" is something they're trying to understand, decide or do, with an end to it.
A "subgoal" is something a goal turned out to NEED: they can't get back up until they understand it.
A "detour" is curiosity off to the side: interesting, but the goal above doesn't need it.
A new card has just been made. Decide which goal it works toward.
- Prefer an existing open goal when the card plainly serves it.
- If the card is about something its source card's goal needs first, make a subgoal under that goal.
- If it wanders away from what that goal needs, make a detour under that goal.
- A goal the learner wrote themselves (marked "theirs") is their purpose for the whole canvas: what they study here serves it.
  A card on a new topic that serves it goes under it as a subgoal (or a detour), not as a goal of its own.
- If there are no goals yet, or it starts something unrelated, make a "goal" with no parent.
Word a new goal as what the learner is after, briefly and in plain words: "Understand why Yugoslavia broke up",
"Know what a generalized coordinate is, to read the Lagrangian". Never more than 12 words.
Return JSON only: {"goal": "<id of an existing goal>"} or {"new": {"text": "...", "parent": "<goal id or null>", "kind": "goal" | "subgoal" | "detour"}}`;

/**
 * The goals the learner wrote that a card serves, outermost first: the lens it's written through.
 * Found by the goal its source card (or theirs, on up) was placed under, walking up to the top; where
 * that finds none the learner wrote, every open goal of theirs at the top of the tree.
 */
export function goalsFor(goals: Goal[], items: Item[], card?: CardItem): Goal[] {
  const live = goals.filter((g) => g.status !== "dropped");
  const mine = live.filter((g) => g.by === "you" && g.status === "open");
  if (!mine.length) return [];
  const byId = new Map(items.map((i) => [i.id, i]));
  // The goal of this card, or of the nearest card it came out of.
  let start: Goal | undefined;
  for (let id: string | undefined = card?.id, n = 0; id && !start && n < 50; n++) {
    start = live.find((g) => g.cards.includes(id!));
    const it = byId.get(id);
    id = it?.kind === "card" ? it.parentId : undefined;
  }
  const chain: Goal[] = [];
  for (let g = start, n = 0; g && n < 20; n++, g = live.find((x) => x.id === g!.parentId)) chain.unshift(g);
  const theirs = chain.filter((g) => g.by === "you");
  return theirs.length ? theirs : mine.filter((g) => !g.parentId);
}

/** The learner's goals, as a lens for a prompt that writes for them; "" if they've set none. */
export function goalLens(goals: Goal[], items: Item[], card?: CardItem): string {
  const lens = goalsFor(goals, items, card);
  if (!lens.length) return "";
  const lines = lens.map((g) => `- ${g.text}`).join("\n");
  return `The reader's goal on this canvas, in their own words${lens.length > 1 ? " (the outer goal first, then what it needs)" : ""}:
${lines}
${lens.length > 1 && !lens.some((g) => g.parentId) ? "These are separate goals: write for whichever this plainly serves.\n" : ""}This goal is the lens for everything you write: it is WHY they want to understand this. Let it decide where you start,
what you explain and what you skip, how deep you go, which examples you use, and what "where it's used" shows. The same
subject reads completely differently for someone building something with it, someone revising for an exam, someone
going back to what they never really understood, or someone using it at work. Show the goal in what you choose, and
don't say it back to them ("since you want to…"). Stay correct about the subject itself: the lens chooses the angle,
not the facts.`;
}

const queues = new Map<string, Promise<unknown>>();

/** What a card is about, in a line. */
const about = (c: CardItem) =>
  [c.objectKind ? `${c.objectKind} found for: ${c.request ?? ""}` : "", c.subject, c.selection && c.selection !== c.subject ? `(about the words "${c.selection.slice(0, 200)}")` : "", c.origin?.kind === "page" ? `(a page read from ${c.origin.url})` : ""]
    .filter(Boolean)
    .join(" ")
    .slice(0, 400);

export async function saveGoal(store: CanvasStore, goal: Goal) {
  await store.record({ type: "goal", goal });
}

async function place(store: CanvasStore, cardId: string) {
  const s = await store.getState();
  const card = s.items.find((i): i is CardItem => i.id === cardId && i.kind === "card");
  if (!card || card.hidden) return;
  const goals = s.goals ?? [];
  if (goals.some((g) => g.cards.includes(cardId))) return;
  const parent = s.items.find((i): i is CardItem => i.id === card.parentId && i.kind === "card");
  const parentGoal = parent ? goals.find((g) => g.cards.includes(parent.id)) : undefined;
  const open = goals.filter((g) => g.status === "open");
  let choice: { goal?: string; new?: { text?: string; parent?: string | null; kind?: string } } = {};
  try {
    choice = await chatJson((await loadConfig()).llm, [
      { role: "system", content: PLACE },
      {
        role: "user",
        content: [
          open.length ? `Open goals:\n${open.map((g) => `- ${g.id} [${g.kind}${g.parentId ? ` under ${g.parentId}` : ""}${g.by === "you" ? ", theirs" : ""}]: ${g.text}`).join("\n")}` : "No goals yet.",
          `The new card: ${about(card)}`,
          parent ? `It came out of the card: ${about(parent)}${parentGoal ? ` (which works toward goal ${parentGoal.id})` : ""}` : "It was started on its own.",
        ].join("\n\n"),
      },
    ]);
  } catch {
    // Without the model: under its source card's goal, or a goal of its own.
  }
  const now = (await store.getState()).goals ?? [];
  const attach = async (g: Goal) => saveGoal(store, { ...g, cards: [...g.cards, cardId] });
  const existing = now.find((g) => g.id === choice.goal && g.status === "open");
  if (existing) return attach(existing);
  const text = String(choice.new?.text ?? "").trim().slice(0, 120);
  if (!text) {
    const fallback = parentGoal && now.find((g) => g.id === parentGoal.id);
    if (fallback) return attach(fallback);
  }
  const kind = (["goal", "subgoal", "detour"] as const).find((k) => k === choice.new?.kind) ?? (parentGoal ? "subgoal" : "goal");
  const parentId = kind === "goal" ? undefined : (now.find((g) => g.id === choice.new?.parent)?.id ?? parentGoal?.id);
  await saveGoal(store, {
    id: newId(),
    text: text || `Understand ${card.subject ?? "this"}`.slice(0, 120),
    ...(parentId ? { parentId } : {}),
    kind: parentId ? kind : "goal",
    status: "open",
    cards: [cardId],
    by: "librarian",
    at: new Date().toISOString(),
  });
}

onCardDone((store, id) => {
  // One at a time per canvas, so two cards finishing together don't both start the same goal.
  const prev = queues.get(store.id) ?? Promise.resolve();
  const next = prev.then(() => place(store, id)).catch((e) => console.warn("goal placing failed:", e));
  queues.set(store.id, next);
});
