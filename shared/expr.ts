// Plain math, as a model writes it for a plot ("sin(x)/x", "2x^2 - 3", "e^(-t) cos(4 pi t)"), parsed
// into a function of x (or t). Nothing is evaluated as code: only numbers, the variable, constants,
// operators and a fixed list of functions.

type Fn = (v: number) => number;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2, sqrt: Math.sqrt, cbrt: Math.cbrt,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, min: Math.min, max: Math.max, pow: Math.pow,
  gamma: gammaFn, erf: erfFn,
};
const CONSTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, inf: Infinity };

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const s = src.replace(/\*\*/g, "^").replace(/[·×]/g, "*").replace(/−/g, "-");
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) i++;
    else if (/[0-9.]/.test(c)) {
      const m = s.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i)!;
      out.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-zA-Zπθφαβ_]/.test(c)) {
      const m = s.slice(i).match(/^[a-zA-Zπθφαβ_][a-zA-Z0-9_]*/)!;
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
    } else if ("+-*/^(),!".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
    } else throw new Error(`Can't read "${c}" in ${src}`);
  }
  return out;
}

/** Splits a run of letters a model glued together ("pix", "xsin") into known names, when it can. */
function splitName(name: string, vars: string[]): string[] | null {
  const known = [...Object.keys(FUNCS), ...Object.keys(CONSTS), ...vars].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let rest = name;
  while (rest) {
    const k = known.find((n) => rest.startsWith(n));
    if (!k) return null;
    out.push(k);
    rest = rest.slice(k.length);
  }
  return out;
}

/** Parses an expression in the given variables into a function of them. Throws on what it can't read. */
export function compile(src: string, vars: string[] = ["x"]): (...v: number[]) => number {
  let toks = lex(src);
  // Glued names: "xsin(x)" → x sin(x); "2pi" is fine already.
  toks = toks.flatMap((t) => (t.k === "id" && !(t.v in FUNCS) && !(t.v in CONSTS) && !vars.includes(t.v) ? (splitName(t.v, vars)?.map((v) => ({ k: "id", v }) as Tok) ?? [t]) : [t]));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.k === "op" && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}" in ${src}`);
    p++;
  };
  type Node = (env: number[]) => number;
  // Starts a factor, for implicit multiplication ("2x", "3(x+1)", "x sin(x)").
  const startsFactor = () => {
    const t = peek();
    return t && (t.k === "num" || t.k === "id" || (t.k === "op" && t.v === "("));
  };
  const expr = (): Node => {
    let l = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[p++].v;
      const a = l, b = term();
      l = op === "+" ? (e) => a(e) + b(e) : (e) => a(e) - b(e);
    }
    return l;
  };
  const term = (): Node => {
    let l = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = toks[p++].v;
        const a = l, b = unary();
        l = op === "*" ? (e) => a(e) * b(e) : (e) => a(e) / b(e);
      } else if (startsFactor()) {
        const a = l, b = power();
        l = (e) => a(e) * b(e);
      } else return l;
    }
  };
  const unary = (): Node => {
    if (isOp("-")) {
      p++;
      const a = unary();
      return (e) => -a(e);
    }
    if (isOp("+")) {
      p++;
      return unary();
    }
    return power();
  };
  const power = (): Node => {
    const base = postfix();
    if (isOp("^")) {
      p++;
      const ex = unary(); // right-associative, and 2^-x works
      return (e) => Math.pow(base(e), ex(e));
    }
    return base;
  };
  const postfix = (): Node => {
    let a = atom();
    while (isOp("!")) {
      p++;
      const b = a;
      a = (e) => gammaFn(b(e) + 1);
    }
    return a;
  };
  const atom = (): Node => {
    const t = toks[p++];
    if (!t) throw new Error(`Unfinished: ${src}`);
    if (t.k === "num") return () => t.v;
    if (t.k === "op" && t.v === "(") {
      const a = expr();
      expect(")");
      return a;
    }
    if (t.k === "op" && t.v === "|") throw new Error("Use abs()");
    if (t.k === "id") {
      const vi = vars.indexOf(t.v);
      if (vi >= 0) return (e) => e[vi];
      const f = FUNCS[t.v];
      if (f) {
        // "sin x" without parentheses takes the next factor; "sin^2(x)" squares it.
        let pow: Node | null = null;
        if (isOp("^")) {
          p++;
          pow = atom();
        }
        const args: Node[] = [];
        if (isOp("(")) {
          p++;
          args.push(expr());
          while (isOp(",")) {
            p++;
            args.push(expr());
          }
          expect(")");
        } else args.push(power());
        const call: Node = (e) => f(...args.map((a) => a(e)));
        return pow ? (e) => Math.pow(call(e), pow!(e)) : call;
      }
      if (t.v in CONSTS) return () => CONSTS[t.v];
      throw new Error(`Unknown name "${t.v}" in ${src}`);
    }
    throw new Error(`Unexpected "${t.v}" in ${src}`);
  };
  const root = expr();
  if (p < toks.length) throw new Error(`Couldn't read past "${toks[p].v}" in ${src}`);
  return (...v: number[]) => root(v);
}

/** A function of one variable, or null when the expression can't be read. */
export function fnOf(src: string, v = "x"): Fn | null {
  // A function written in another single variable ("cos(t)", "sin(θ)") is read in that one.
  for (let tries = 0, name = v; tries < 2; tries++) {
    try {
      const f = compile(src, [name]);
      return (x) => f(x);
    } catch (err) {
      const other = err instanceof Error ? err.message.match(/^Unknown name "([a-zA-Zθφαβ]\w{0,5})"/)?.[1] : undefined;
      if (!other || other === name) return null;
      name = other;
    }
  }
  return null;
}

function gammaFn(z: number): number {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

function erfFn(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
