// F-FIG-2 (plots): the model's math is parsed, never run.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compile, fnOf } from "../../shared/expr.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

describe("expressions", () => {
  test("arithmetic and precedence", () => {
    near(compile("1 + 2 * 3")(), 7);
    near(compile("2^3^2")(), 512); // right-associative
    near(compile("-2^2")(), -4);
    near(compile("(1+2)*3")(), 9);
    near(compile("10 / 4")(), 2.5);
  });

  test("the variable, constants and functions", () => {
    const f = fnOf("sin(x)/x")!;
    near(f(Math.PI / 2), 2 / Math.PI);
    near(fnOf("e^x")!(1), Math.E);
    near(fnOf("pi")!(0), Math.PI);
    near(fnOf("π*x")!(2), 2 * Math.PI);
    near(fnOf("sqrt(x) + abs(-x)")!(4), 6);
    near(fnOf("max(x, 3)")!(1), 3);
    near(fnOf("ln(e)")!(0), 1);
    near(fnOf("log(100)")!(0), 2);
  });

  test("implicit multiplication as a model writes it", () => {
    near(fnOf("2x^2 - 3")!(2), 5);
    near(fnOf("2pi x")!(1), 2 * Math.PI);
    near(fnOf("x sin(x)")!(Math.PI / 2), Math.PI / 2);
    near(fnOf("xsin(x)")!(Math.PI / 2), Math.PI / 2); // glued names are split
    near(fnOf("(x+1)(x-1)")!(3), 8);
    near(fnOf("3(x+1)")!(1), 6);
  });

  test("powers of functions and factorial", () => {
    near(fnOf("sin^2(x) + cos^2(x)")!(0.7), 1);
    near(fnOf("x!")!(5), 120);
    near(fnOf("gamma(5)")!(0), 24, 1e-6);
    near(fnOf("erf(0)")!(0), 0, 1e-6);
  });

  test("Unicode and ** spellings", () => {
    near(fnOf("x ** 2")!(3), 9);
    near(fnOf("2 × x")!(3), 6);
    near(fnOf("x − 1")!(3), 2);
  });

  test("a function written in another single variable is read in that one", () => {
    near(fnOf("cos(t)")!(0), 1);
    near(fnOf("sin(θ)")!(Math.PI / 2), 1);
    near(fnOf("t^2", "t")!(3), 9);
  });

  test("several variables", () => {
    near(compile("x*y + 1", ["x", "y"])(2, 3), 7);
  });

  test("nothing that isn't math is run", () => {
    assert.equal(fnOf("process.exit(1)"), null);
    assert.equal(fnOf("alert(1)"), null);
    assert.equal(fnOf("x; y"), null);
    assert.equal(fnOf("constructor"), null);
    assert.equal(fnOf("toString(x)"), null); // not through Object.prototype
    assert.equal(fnOf("hasOwnProperty(x)"), null);
    assert.equal(fnOf("__proto__"), null);
    assert.equal(fnOf("x +"), null);
    assert.equal(fnOf("sin(x) + y + z"), null); // two unknowns
    assert.throws(() => compile("require('fs')"));
  });
});
