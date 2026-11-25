// A throwaway data folder and settings file for one test file, pointing the language model at the
// fake. Set before Librarian's modules are imported: they read these when they load.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function testEnv(llmUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), "librarian-test-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      llm: { baseUrl: `${llmUrl}/v1`, model: "fake-model", apiKey: "sk-test-secret-1234", timeoutSeconds: 20 },
      systemOne: { baseUrl: "", model: "", apiKey: "", timeoutSeconds: 10 },
      diagram: { baseUrl: "", model: "", apiKey: "", timeoutSeconds: 20 },
      // No web search: tests never leave this machine.
      searchers: { keenable: { enabled: false, baseUrl: "", apiKey: "" } },
    }),
  );
  return { LIBRARIAN_DATA: path.join(dir, "data"), SEMSHAPES_CONFIG: config, ...extra };
}

/** Sets the environment for in-process tests. */
export function useEnv(env: Record<string, string>) {
  Object.assign(process.env, env);
}

/** Waits until `check` returns something truthy, or fails after `ms`. */
export async function until<T>(check: () => Promise<T> | T, ms = 10_000, what = "condition"): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
