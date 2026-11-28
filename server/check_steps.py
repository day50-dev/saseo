"""Checks someone's written working, step by step, with SymPy.

Reads {"steps": ["sympy text", ...]} on stdin and writes {"results": [{"status", "note"}, ...]}:
the first parsed step is "given"; each later one is "ok" when it follows from the step before it,
"wrong" when it plainly doesn't, and "unchecked" when it can't be told (not maths, can't be read,
or a kind of step this doesn't check). A wrong step is only called wrong when SymPy is sure:
simplifying didn't show the two agree AND they differ when numbers are put in.
"""

import json
import random
import signal
import sys

from sympy import Eq, I, nan, oo, simplify, solveset, S, zoo
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

TRANSFORMS = standard_transformations + (implicit_multiplication_application, convert_xor)
STEP_SECONDS = 4


class TooLong(Exception):
    pass


def _alarm(_sig, _frame):
    raise TooLong()


signal.signal(signal.SIGALRM, _alarm)


def parse(text):
    """An expression, or ("eq", lhs - rhs, lhs, rhs) for an equation; None if it can't be read."""
    t = (text or "").strip()
    if not t:
        return None
    t = t.replace("==", "=")
    if any(op in t for op in ("<", ">", "≤", "≥", "!=")):
        return None  # inequalities aren't checked
    parts = t.split("=")
    try:
        if len(parts) == 1:
            return ("expr", parse_expr(parts[0], transformations=TRANSFORMS).doit())
        if len(parts) == 2:
            lhs = parse_expr(parts[0], transformations=TRANSFORMS).doit()
            rhs = parse_expr(parts[1], transformations=TRANSFORMS).doit()
            return ("eq", lhs - rhs, lhs, rhs)
    except Exception:
        return None
    return None


def samples(expr_syms, n=6):
    rnd = random.Random(7)
    for _ in range(n):
        yield {s: S(rnd.uniform(0.3, 2.7)).n(30) for s in expr_syms}


def differs_numerically(d):
    """True if d is plainly not zero for some numbers put in; False if it's ~0 at all; None if unsure."""
    syms = list(d.free_symbols)
    seen = 0
    for vals in samples(syms):
        try:
            v = complex(d.subs(vals).evalf(30))
        except Exception:
            continue
        if v != v or abs(v) == float("inf"):  # nan / inf
            continue
        seen += 1
        if abs(v) > 1e-9:
            return True
    return False if seen >= 3 else None


def same_value(a, b):
    """Two expressions: equal (True), not (False), or unsure (None)."""
    d = a - b
    try:
        if simplify(d) == 0:
            return True
    except TooLong:
        raise
    except Exception:
        pass
    diff = differs_numerically(d)
    if diff is None:
        return None
    return not diff


def solutions(f, x):
    s = solveset(f, x, domain=S.Complexes)
    return s


def same_equation(prev, cur):
    """Two equations: does cur follow from prev? (True, note) / (False, note) / (None, note)."""
    fa, fb = prev[1], cur[1]
    if fb == 0:
        return None, "nothing left to compare"
    try:
        r = simplify(fa / fb)
        if not r.free_symbols and r not in (0, nan, oo, zoo):
            return True, ""
    except TooLong:
        raise
    except Exception:
        pass
    syms = fa.free_symbols | fb.free_symbols
    if len(syms) != 1:
        return None, "more than one unknown"
    x = next(iter(syms))
    try:
        sa, sb = solutions(fa, x), solutions(fb, x)
    except TooLong:
        raise
    except Exception:
        return None, "couldn't solve it to compare"
    if sa == sb:
        return True, ""
    # "x = 3" picked out of "x = 3 or x = -3" still follows.
    lhs, rhs = cur[2], cur[3]
    if lhs == x and not rhs.free_symbols:
        try:
            if sa.is_FiniteSet and any(simplify(v - rhs) == 0 for v in sa):
                others = [v for v in sa if simplify(v - rhs) != 0]
                return True, f"one of the solutions; the line before also has {x} = {', '.join(str(v) for v in others)}" if others else ""
        except Exception:
            pass
        return False, f"{x} = {rhs} doesn't solve the line before"
    try:
        if sb.is_subset(sa) and sb != sa:
            return False, "a solution was lost"
        if sa.is_subset(sb) and sb != sa:
            return None, "this may have added a solution; check it in the original"
    except Exception:
        pass
    return False, ""


def check(steps):
    results = []
    prev = None
    for text in steps:
        cur = parse(text)
        if cur is None:
            results.append({"status": "unchecked", "note": "not something this can check" if text else "not maths"})
            continue
        if prev is None:
            results.append({"status": "given", "note": ""})
            prev = cur
            continue
        signal.alarm(STEP_SECONDS)
        try:
            if prev[0] == "expr" and cur[0] == "expr":
                ok, note = same_value(prev[1], cur[1]), ""
            elif prev[0] == "eq" and cur[0] == "eq":
                ok, note = same_equation(prev, cur)
            elif prev[0] == "eq" and cur[0] == "expr":
                # A new expression after an equation: carrying on from its right-hand side ("= ...").
                ok, note = same_value(prev[3], cur[1]), ""
            else:
                # An equation after an expression: its left side should be what came before.
                ok, note = same_value(prev[1], cur[2]), ""
                if ok:
                    ok = same_value(cur[2], cur[3])
        except TooLong:
            ok, note = None, "took too long to check"
        except Exception as e:  # noqa: BLE001
            ok, note = None, f"couldn't check: {type(e).__name__}"
        finally:
            signal.alarm(0)
        results.append({"status": "ok" if ok else "wrong" if ok is False else "unchecked", "note": note})
        # Carry on from this step even when it's wrong: the next is judged against what was written.
        prev = cur
    return results


if __name__ == "__main__":
    data = json.load(sys.stdin)
    print(json.dumps({"results": check([str(s) for s in data.get("steps", [])])}))
