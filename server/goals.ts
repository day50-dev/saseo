// Goals: what the learner is after, and what they had to go and find out on the way. Each card that
// finishes is placed under one: the goal it works toward, a new subgoal (something that goal turned
// out to need), or a detour (curiosity off to the side). The first card on a canvas starts its first
// goal. The learner can add, reword, finish and clear goals; the librarian only guesses.
import type { CardItem, Goal } from "../shared/canvas.ts";
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
- If there are no goals yet, or it starts something unrelated, make a "goal" with no parent.
Word a new goal as what the learner is after, briefly and in plain words: "Understand why Yugoslavia broke up",
"Know what a generalized coordinate is, to read the Lagrangian". Never more than 12 words.
Return JSON only: {"goal": "<id of an existing goal>"} or {"new": {"text": "...", "parent": "<goal id or null>", "kind": "goal" | "subgoal" | "detour"}}`;

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
          open.length ? `Open goals:\n${open.map((g) => `- ${g.id} [${g.kind}${g.parentId ? ` under ${g.parentId}` : ""}]: ${g.text}`).join("\n")}` : "No goals yet.",
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
