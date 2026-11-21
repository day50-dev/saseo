// Calls to the configured LLM, System One decision model and searchers.
import { createSearchClient } from "agent-web-search";
import { Keenable } from "keenable";
import {
  SEARCHER_IDS,
  SEARCHERS,
  type SearcherId,
  type SearcherResult,
  type SearchHit,
  type TestResult,
} from "../shared/providers.ts";
import type { Config, Endpoint } from "./config.ts";

const TIMEOUT_MS = 30_000;

function headers(ep: Endpoint): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ep.apiKey) h.Authorization = `Bearer ${ep.apiKey}`;
  return h;
}

async function timed(fn: () => Promise<Omit<TestResult, "ms">>): Promise<TestResult> {
  const start = performance.now();
  try {
    const r = await fn();
    return { ...r, ms: Math.round(performance.now() - start) };
  } catch (err) {
    return { ok: false, message: describe(err), ms: Math.round(performance.now() - start) };
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `No response within ${TIMEOUT_MS / 1000}s`;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause?.message ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}

async function failure(res: Response): Promise<Omit<TestResult, "ms">> {
  const body = await res.text();
  let detail: unknown = body.slice(0, 2000);
  try {
    detail = JSON.parse(body);
  } catch {}
  return { ok: false, message: `HTTP ${res.status} ${res.statusText}`, detail };
}

/** Checks an OpenAI-compatible chat endpoint with a one-word request. */
export function testLlm(ep: Endpoint): Promise<TestResult> {
  return timed(async () => {
    if (!ep.baseUrl) return { ok: false, message: "Set a base URL first" };
    if (!ep.model) return { ok: false, message: "Set a model first" };
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(ep),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
    if (!res.ok) return failure(res);
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string") {
      return { ok: false, message: "Response had no choices[0].message.content", detail: data };
    }
    return { ok: true, message: `Replied: “${reply.trim().slice(0, 80)}”`, detail: { model: data.model } };
  });
}

/** Lists models from an OpenAI-style GET /models, for the model dropdown. */
export async function listModels(ep: Endpoint): Promise<string[]> {
  const res = await fetch(`${ep.baseUrl}/models`, {
    headers: headers(ep),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  const items: unknown[] = Array.isArray(data) ? data : (data?.data ?? data?.models ?? []);
  return items
    .map((m) => (typeof m === "string" ? m : (m as { id?: string; name?: string })?.id ?? (m as { name?: string })?.name))
    .filter((id): id is string => typeof id === "string")
    .sort();
}

/** Checks a System One endpoint (POST {base}/systemone) with one yes/no question. */
export function testSystemOne(ep: Endpoint): Promise<TestResult> {
  return timed(async () => {
    if (!ep.baseUrl) return { ok: false, message: "Set a base URL first" };
    if (!ep.model) return { ok: false, message: "Set a model first" };
    const res = await fetch(`${ep.baseUrl}/systemone`, {
      method: "POST",
      headers: headers(ep),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: ep.model,
        state: "Ampère's law relates the magnetic field around a loop to the current through it.",
        questions: {
          physics: { type: "noul", instructions: "Is this text about physics?" },
        },
      }),
    });
    if (!res.ok) return failure(res);
    const data = await res.json();
    const p = data?.answers?.physics?.noul;
    if (typeof p !== "number") {
      return { ok: false, message: "Response had no answers.physics.noul", detail: data };
    }
    return {
      ok: true,
      message: `“Is this about physics?” → ${(p * 100).toFixed(0)}% yes (${data.model})`,
      detail: data,
    };
  });
}

async function searchKeenable(
  apiKey: string,
  query: string,
  count: number,
): Promise<SearchHit[]> {
  const client = new Keenable({
    apiKey: apiKey || undefined,
    // Keyless requests must name the calling app.
    clientSource: "semshapes",
    timeoutMs: TIMEOUT_MS,
  });
  const res = await client.search(query, { maxResults: count, snippetMaxLength: 500 });
  return res.results.map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.snippet,
    publishedDate: r.publishedAt,
  }));
}

async function searchOther(
  id: Exclude<SearcherId, "keenable">,
  s: Config["searchers"][SearcherId],
  query: string,
  count: number,
): Promise<SearchHit[]> {
  const cfg: Record<string, unknown> = { timeoutMs: TIMEOUT_MS };
  if (s.apiKey) cfg.apiKey = s.apiKey;
  if (SEARCHERS[id].needsBaseUrl) cfg.baseUrl = s.baseUrl;
  const client = createSearchClient({ [id]: cfg } as Parameters<typeof createSearchClient>[0]);
  const res = await client.search({ query, count });
  const r = res[id];
  if (!r) throw new Error("No response from engine");
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.results.map((h) => ({
    url: h.url,
    title: h.title ?? h.url,
    snippet: h.snippet ?? h.snippets?.join(" … ") ?? "",
    publishedDate: h.publishedDate ?? undefined,
  }));
}

function missing(id: SearcherId, s: Config["searchers"][SearcherId]): string | undefined {
  if (SEARCHERS[id].key === "required" && !s.apiKey) return "Needs an API key";
  if (SEARCHERS[id].needsBaseUrl && !s.baseUrl) return "Needs a base URL";
  return undefined;
}

/** Runs one query on each requested searcher in parallel; one failing doesn't stop the rest. */
export async function runSearch(
  config: Config,
  query: string,
  ids: SearcherId[],
  count = 5,
): Promise<Partial<Record<SearcherId, SearcherResult>>> {
  const wanted = ids.filter((id) => SEARCHER_IDS.includes(id));
  const entries = await Promise.all(
    wanted.map(async (id): Promise<[SearcherId, SearcherResult]> => {
      const s = config.searchers[id];
      const problem = missing(id, s);
      if (problem) return [id, { ok: false, ms: 0, hits: [], error: problem }];
      const start = performance.now();
      try {
        const hits =
          id === "keenable"
            ? await searchKeenable(s.apiKey, query, count)
            : await searchOther(id, s, query, count);
        return [id, { ok: true, ms: Math.round(performance.now() - start), hits }];
      } catch (err) {
        return [id, { ok: false, ms: Math.round(performance.now() - start), hits: [], error: describe(err) }];
      }
    }),
  );
  return Object.fromEntries(entries);
}
