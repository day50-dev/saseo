import type {
  ConfigUpdate,
  PublicConfig,
  SearcherId,
  SearcherResult,
  TestResult,
} from "../shared/providers.ts";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
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
