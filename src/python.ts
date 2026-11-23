// Python in the browser, for notebooks: Pyodide (CPython compiled to WebAssembly) in a worker, so a
// long computation never freezes the canvas. One Python per page, shared by every notebook, like a
// kernel: variables a cell defines stay for the next. Packages a cell imports (numpy, matplotlib,
// sympy, pandas, scikit-learn…) are fetched the first time they're needed.

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";

export interface CellOutput {
  /** What it printed. */
  stdout: string;
  /** Warnings and the traceback, if it failed. */
  stderr: string;
  /** The value of its last line, as Python shows it. */
  result?: string;
  /** Plots it drew, as PNG data. */
  images: string[];
  error?: boolean;
}

const WORKER = `
importScripts(${JSON.stringify(`${PYODIDE}pyodide.js`)});
let ready = (async () => {
  self.postMessage({ type: "status", text: "Starting Python…" });
  const py = await loadPyodide({ indexURL: ${JSON.stringify(PYODIDE)} });
  py.runPython(\`
import ast, sys, io, base64, traceback, json, warnings
# plt.show() has nowhere to show here; the figures are collected after each cell instead.
warnings.filterwarnings("ignore", message=".*non-interactive.*")
G = {"__name__": "__main__"}
def __run(src):
    out, err = io.StringIO(), io.StringIO()
    old = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    result, failed = None, False
    try:
        if "matplotlib" in sys.modules or "matplotlib" in src or "pyplot" in src:
            import matplotlib
            matplotlib.use("Agg")
        tree = ast.parse(src)
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, "<cell>", "exec"), G)
        if last is not None:
            v = eval(compile(last, "<cell>", "eval"), G)
            if v is not None:
                result = repr(v)
    except BaseException:
        failed = True
        lines = traceback.format_exc().splitlines()
        # Leave out the frames of this runner itself.
        keep = [l for l in lines if "__run" not in l and 'File "<exec>"' not in l]
        err.write("\\\\n".join(keep))
    finally:
        sys.stdout, sys.stderr = old
    images = []
    if "matplotlib.pyplot" in sys.modules:
        import matplotlib.pyplot as plt
        for n in plt.get_fignums():
            buf = io.BytesIO()
            plt.figure(n).savefig(buf, format="png", bbox_inches="tight", dpi=96)
            images.append(base64.b64encode(buf.getvalue()).decode())
        plt.close("all")
    return json.dumps({"stdout": out.getvalue(), "stderr": err.getvalue(), "result": result, "images": images, "error": failed})
\`);
  self.postMessage({ type: "status", text: "" });
  return py;
})();

// Notebook magics and shell lines (%matplotlib inline, !pip install …) mean nothing here.
const clean = (src) => src.split("\\n").filter((l) => !/^\\s*[%!]/.test(l)).join("\\n");

self.onmessage = async (e) => {
  const { id, code } = e.data;
  try {
    const py = await ready;
    const src = clean(code);
    self.postMessage({ type: "status", text: "Loading packages…" });
    await py.loadPackagesFromImports(src).catch(() => {});
    self.postMessage({ type: "status", text: "" });
    const out = JSON.parse(py.globals.get("__run")(src));
    self.postMessage({ type: "done", id, out });
  } catch (err) {
    self.postMessage({ type: "done", id, out: { stdout: "", stderr: String(err), images: [], error: true } });
  }
};
`;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (o: CellOutput) => void>();
const listeners = new Set<(status: string) => void>();
let status = "";

function start(): Worker {
  if (worker) return worker;
  worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
  worker.onmessage = (e: MessageEvent<{ type: string; id?: number; out?: CellOutput; text?: string }>) => {
    if (e.data.type === "status") {
      status = e.data.text ?? "";
      for (const l of listeners) l(status);
    } else if (e.data.type === "done" && e.data.id !== undefined) {
      waiting.get(e.data.id)?.(e.data.out!);
      waiting.delete(e.data.id);
    }
  };
  return worker;
}

/** Runs a cell's code; resolves with what it printed, returned and drew. Cells run one at a time. */
export function runPython(code: string): Promise<CellOutput> {
  const w = start();
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, code });
  });
}

/** Starts Python ahead of the first run (it takes a few seconds). */
export const warmPython = () => void start();

/** What Python is busy with ("Starting Python…", "Loading packages…"), or "". */
export function onPythonStatus(fn: (status: string) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

/** Starts over: a fresh Python, with nothing defined. */
export function restartPython() {
  worker?.terminate();
  worker = null;
  for (const resolve of waiting.values()) resolve({ stdout: "", stderr: "Python was restarted.", images: [], error: true });
  waiting.clear();
  status = "";
  for (const l of listeners) l(status);
}
