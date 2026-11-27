// Which of the learner's goals a card is written for: the lens (server/goals.ts puts it in prompts;
// the Goals panel counts the cards a goal would re-explain).
import type { CardItem, Goal, Item } from "./canvas.ts";

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

/** An explanation that can be written again through a goal: words explained, not a page, a found thing or a relation. */
export const reExplainable = (c: CardItem) => c.stage === "done" && !c.hidden && Boolean(c.sem) && !c.objectKind && !c.relates && !c.origin;

/** The cards that would read differently through this goal: it's their lens now, and they weren't written through it. */
export function cardsToReExplain(goal: Goal, goals: Goal[], items: Item[]): CardItem[] {
  return items.filter(
    (c): c is CardItem =>
      c.kind === "card" && reExplainable(c) && !(c.lens ?? []).includes(goal.text) && goalsFor(goals, items, c).some((g) => g.id === goal.id),
  );
}
