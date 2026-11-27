// Which of the learner's goals a card is written for: the lens (server/goals.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { goalLens, goalsFor } from "../../server/goals.ts";
import type { CardItem, Goal, Item } from "../../shared/canvas.ts";

const goal = (id: string, text: string, extra: Partial<Goal> = {}): Goal => ({ id, text, kind: extra.parentId ? "subgoal" : "goal", status: "open", cards: [], by: "you", at: "", ...extra });
const card = (id: string, parentId = ""): CardItem => ({ kind: "card", id, parentId, x: 0, y: 0, w: 720, stage: "done" });

describe("F-GOAL-LENS: the learner's goal is the lens", () => {
  test("no goals of theirs: no lens", () => {
    assert.deepEqual(goalsFor([goal("g", "Understand eigenvectors", { by: "librarian" })], [], card("a")), []);
    assert.equal(goalLens([], [], card("a")), "");
  });
  test("a new card with nothing above it is written for their top goal", () => {
    const g = goal("g", "Make a 3D game");
    assert.deepEqual(goalsFor([g], [], card("a")).map((x) => x.text), ["Make a 3D game"]);
    assert.match(goalLens([g], [], card("a")), /Make a 3D game[\s\S]*lens/);
  });
  test("a card follows its source card's goal, up through the subgoals they wrote", () => {
    const top = goal("top", "Pass my linear algebra exam");
    const sub = goal("sub", "Get eigenvalues by hand", { parentId: "top", cards: ["a"] });
    const other = goal("other", "Make a 3D game");
    const items: Item[] = [card("a"), card("b", "a")];
    assert.deepEqual(goalsFor([top, sub, other], items, card("b", "a")).map((x) => x.id), ["top", "sub"]);
  });
  test("under a goal the librarian guessed, their own top goals still apply", () => {
    const guessed = goal("lib", "Understand eigenvectors", { by: "librarian", cards: ["a"] });
    const theirs = goal("me", "Use it in civil engineering");
    assert.deepEqual(goalsFor([guessed, theirs], [card("a")], card("b", "a")).map((x) => x.id), ["me"]);
  });
  test("a goal they cleared is no lens", () => {
    assert.deepEqual(goalsFor([goal("g", "Make a 3D game", { status: "dropped" })], [], card("a")), []);
  });
});
