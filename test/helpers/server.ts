// Runs the real server (server/index.ts) on a free port with a test's data folder and settings,
// for tests that go through HTTP the way the page does.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

export async function startServer(env: Record<string, string>) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), BETTER_AUTH_URL: `http://localhost:${port}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server didn't start:\n${log}`)), 30_000);
    child.stdout.on("data", () => {
      if (log.includes("librarian API on")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}:\n${log}`)));
  });
  const url = `http://localhost:${port}`;
  /** A JSON request; returns the status and parsed body. */
  const api = async (method: string, p: string, json?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${url}${p}`, {
      method,
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const type = r.headers.get("content-type") ?? "";
    const body = type.includes("json") ? await r.json() : await r.text();
    return { status: r.status, body, headers: r.headers };
  };
  return {
    url,
    api,
    log: () => log,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

export type TestServer = Awaited<ReturnType<typeof startServer>>;
