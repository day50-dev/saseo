// Stores the configuration, keys included, in a local JSON file readable only by its owner.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ConfigUpdate,
  type KeyUpdate,
  MODEL_DEFAULTS,
  TIMEOUT_LIMITS,
  type PublicConfig,
  PROTOCOLS,
  type Protocol,
  SEARCHER_IDS,
  SEARCHERS,
  type SearcherId,
} from "../shared/providers.ts";

export interface Endpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** How long to wait for one answer before giving up. */
  timeoutSeconds: number;
  /** OpenAI's chat completions, or Anthropic's Messages API. */
  protocol: Protocol;
}

/** Speaking aloud on a call (OpenAI-compatible POST /audio/speech). */
export interface Tts {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
}

/** Embeddings, for finding passages in a long text by meaning (an Ollama-style POST /api/embeddings). Blank baseUrl: none, keyword search only. */
export interface Embed {
  baseUrl: string;
  model: string;
}

export interface Searcher {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
}

export interface Config {
  llm: Endpoint;
  systemOne: Endpoint;
  /** Draws SVG diagrams; blank fields fall back to `llm`'s (see diagramEndpoint). */
  diagram: Endpoint;
  tts: Tts;
  embed: Embed;
  searchers: Record<SearcherId, Searcher>;
}

/** The endpoint that draws diagrams: its own where set, else the language model's server, key and model. */
export function diagramEndpoint(config: Config): Endpoint {
  const d = config.diagram;
  const own = Boolean(d.baseUrl);
  return {
    baseUrl: own ? d.baseUrl : config.llm.baseUrl,
    apiKey: own ? d.apiKey : config.llm.apiKey,
    model: d.model || config.llm.model,
    timeoutSeconds: d.timeoutSeconds || config.llm.timeoutSeconds,
    protocol: own ? d.protocol : config.llm.protocol,
  };
}

export const CONFIG_PATH =
  process.env.SEMSHAPES_CONFIG ?? path.resolve("data", "config.json");

function defaults(): Config {
  const searchers = {} as Record<SearcherId, Searcher>;
  for (const id of SEARCHER_IDS) {
    searchers[id] = {
      // Keenable needs no key, so search works out of the box.
      enabled: id === "keenable",
      baseUrl: SEARCHERS[id].defaultBaseUrl ?? "",
      apiKey: "",
    };
  }
  return {
    llm: { ...MODEL_DEFAULTS.llm, apiKey: "" },
    systemOne: { ...MODEL_DEFAULTS.systemOne, apiKey: "" },
    diagram: { ...MODEL_DEFAULTS.diagram, apiKey: "" },
    // Servers set up before speech was in Settings named it in the environment; that's the default.
    tts: {
      baseUrl: process.env.LIBRARIAN_TTS_URL ? `${process.env.LIBRARIAN_TTS_URL.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1` : "",
      apiKey: "",
      model: "",
      voice: process.env.LIBRARIAN_VOICE ?? (process.env.LIBRARIAN_TTS_URL ? "af_heart" : ""),
    },
    embed: { baseUrl: "", model: "qwen3-embedding:0.6b" },
    searchers,
  };
}

export async function loadConfig(): Promise<Config> {
  const base = defaults();
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return {
    llm: { ...base.llm, ...stored.llm },
    systemOne: { ...base.systemOne, ...stored.systemOne },
    diagram: { ...base.diagram, ...stored.diagram },
    tts: { ...base.tts, ...stored.tts },
    embed: { ...base.embed, ...stored.embed },
    searchers: Object.fromEntries(
      SEARCHER_IDS.map((id) => [id, { ...base.searchers[id], ...stored.searchers?.[id] }]),
    ) as Record<SearcherId, Searcher>,
  };
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, CONFIG_PATH);
}

function applyKey(current: string, update: KeyUpdate): string {
  if (update === undefined) return current;
  if (update === null) return "";
  return update.trim();
}

const clean = (url: string) => url.trim().replace(/\/+$/, "");

export async function updateConfig(update: ConfigUpdate): Promise<Config> {
  const config = await loadConfig();
  for (const which of ["llm", "systemOne", "diagram"] as const) {
    const u = update[which];
    if (!u) continue;
    const ep = config[which];
    if (u.baseUrl !== undefined) ep.baseUrl = clean(u.baseUrl);
    if (u.model !== undefined) ep.model = u.model.trim();
    if (typeof u.timeoutSeconds === "number" && Number.isFinite(u.timeoutSeconds)) {
      ep.timeoutSeconds = Math.round(Math.min(TIMEOUT_LIMITS.max, Math.max(TIMEOUT_LIMITS.min, u.timeoutSeconds)));
    }
    if (u.protocol && PROTOCOLS.includes(u.protocol)) ep.protocol = u.protocol;
    ep.apiKey = applyKey(ep.apiKey, u.apiKey);
  }
  if (update.tts) {
    const u = update.tts;
    const t = config.tts;
    if (u.baseUrl !== undefined) t.baseUrl = clean(u.baseUrl);
    if (u.model !== undefined) t.model = u.model.trim();
    if (u.voice !== undefined) t.voice = u.voice.trim();
    t.apiKey = applyKey(t.apiKey, u.apiKey);
  }
  for (const id of SEARCHER_IDS) {
    const u = update.searchers?.[id];
    if (!u) continue;
    const s = config.searchers[id];
    if (u.enabled !== undefined) s.enabled = u.enabled;
    if (u.baseUrl !== undefined) s.baseUrl = clean(u.baseUrl);
    s.apiKey = applyKey(s.apiKey, u.apiKey);
  }
  await saveConfig(config);
  return config;
}

const hint = (key: string) => (key ? `…${key.slice(-4)}` : "");

export function toPublic(config: Config): PublicConfig {
  const ep = (e: Endpoint) => ({
    baseUrl: e.baseUrl,
    model: e.model,
    timeoutSeconds: e.timeoutSeconds,
    protocol: e.protocol,
    hasKey: e.apiKey !== "",
    keyHint: hint(e.apiKey),
  });
  return {
    llm: ep(config.llm),
    systemOne: ep(config.systemOne),
    diagram: ep(config.diagram),
    tts: { baseUrl: config.tts.baseUrl, model: config.tts.model, voice: config.tts.voice, hasKey: config.tts.apiKey !== "", keyHint: hint(config.tts.apiKey) },
    searchers: Object.fromEntries(
      SEARCHER_IDS.map((id) => {
        const s = config.searchers[id];
        return [
          id,
          { enabled: s.enabled, baseUrl: s.baseUrl, hasKey: s.apiKey !== "", keyHint: hint(s.apiKey) },
        ];
      }),
    ) as PublicConfig["searchers"],
  };
}
