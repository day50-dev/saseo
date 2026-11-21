import type {
  ConfigUpdate,
  PublicConfig,
  SearcherId,
  SearcherResult,
  TestResult,
} from "../shared/providers.ts";

/** The dev proxy answers 502-504 when the API server is down or restarting after an edit. */
export const unreachable = (status: number) =>
  status >= 502 && status <= 504
    ? "Can't reach the local server; it may be restarting. Try again in a moment."
    : undefined;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401) location.reload();
  if (!res.ok) throw new Error(unreachable(res.status) ?? `${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => call<PublicConfig>("/api/config"),
  saveConfig: (update: ConfigUpdate) =>
    call<PublicConfig>("/api/config", { method: "PUT", body: JSON.stringify(update) }),
  testLlm: () => call<TestResult>("/api/test/llm", { method: "POST" }),
  testSystemOne: () => call<TestResult>("/api/test/systemone", { method: "POST" }),
  listModels: (which: "llm" | "systemOne") =>
    call<{ models: string[]; error?: string }>(`/api/models/${which}`),
  search: (query: string, searchers: SearcherId[], count = 5) =>
    call<Partial<Record<SearcherId, SearcherResult>>>("/api/search", {
      method: "POST",
      body: JSON.stringify({ query, searchers, count }),
    }),
};
