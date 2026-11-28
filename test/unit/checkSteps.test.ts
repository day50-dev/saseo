// The step checker (server/check_steps.py, through checkSteps): SymPy, not the model, says whether
// each line of someone's working follows from the line before.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkSteps } from "../../server/work.ts";

const statuses = async (steps: string[]) => (await checkSteps(steps)).map((r) => r.status);

describe("F-CHECK: each step checked with SymPy", () => {
  test("a correct solution follows all the way", async () => {
    assert.deepEqual(await statuses(["3*(x - 2) + 4 = 2*x + 9", "3*x - 2 = 2*x + 9", "x = 11"]), ["given", "ok", "ok"]);
  });
  test("a sign slip is the first wrong step; what follows from it is still judged against it", async () => {
    assert.deepEqual(await statuses(["3*x - 6 + 4 = 2*x + 9", "3*x + 2 = 2*x + 9", "x + 2 = 9", "x = 7"]), ["given", "wrong", "ok", "ok"]);
  });
  test("expanding, differentiating and integrating", async () => {
    assert.deepEqual(await statuses(["(x+1)**2", "x**2 + 2*x + 1"]), ["given", "ok"]);
    assert.deepEqual(await statuses(["(x+1)**2", "x**2 + 1"]), ["given", "wrong"]);
    assert.deepEqual(await statuses(["Derivative(x**2*sin(x), x)", "2*x*sin(x) + x**2*cos(x)"]), ["given", "ok"]);
    assert.deepEqual(await statuses(["Derivative(x**2*sin(x), x)", "2*x*sin(x) - x**2*cos(x)"]), ["given", "wrong"]);
    assert.deepEqual(await statuses(["Integral(2*x, (x, 0, 3))", "9"]), ["given", "ok"]);
  });
  test("an equation carried on as a chain of expressions", async () => {
    assert.deepEqual(await statuses(["f = Derivative(x**3, x)", "3*x**2"]), ["given", "ok"]);
  });
  test("picking one root says the other was there", async () => {
    const r = await checkSteps(["x**2 = 3*x", "x = 3"]);
    assert.equal(r[1].status, "ok");
    assert.match(r[1].note ?? "", /x = 0/);
  });
  test("words and what can't be read aren't judged", async () => {
    assert.deepEqual(await statuses(["", "2*x = 4", "x >= 2"]), ["unchecked", "given", "unchecked"]);
  });
});
