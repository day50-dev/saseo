// Provider metadata shared by the server and the settings panel.

export type KeyRule = "none" | "optional" | "required";

export interface SearcherInfo {
  id: SearcherId;
  label: string;
  key: KeyRule;
  needsBaseUrl: boolean;
  defaultBaseUrl?: string;
  note: string;
  signupUrl?: string;
}

export const SEARCHER_IDS = [
  "keenable",
  "searxng",
  "brave",
  "exa",
  "sonar",
  "parallel",
  "you",
  "tavily",
] as const;

export type SearcherId = (typeof SEARCHER_IDS)[number];

export const SEARCHERS: Record<SearcherId, SearcherInfo> = {
  keenable: {
    id: "keenable",
    label: "Keenable",
    key: "optional",
    needsBaseUrl: false,
    note: "Works without a key (shared limit of 1,000 requests/hour per IP). A free key raises it.",
    signupUrl: "https://keenable.ai",
  },
  searxng: {
    id: "searxng",
    label: "SearXNG",
    key: "optional",
    needsBaseUrl: true,
    defaultBaseUrl: "http://localhost:8080",
    note: "Self-hosted metasearch. The instance must allow JSON output (search.formats: [html, json]).",
    signupUrl: "https://docs.searxng.org",
  },
  brave: {
    id: "brave",
    label: "Brave Search",
    key: "required",
    needsBaseUrl: false,
    note: "Independent index.",
    signupUrl: "https://brave.com/search/api/",
  },
  exa: {
    id: "exa",
    label: "Exa",
    key: "required",
    needsBaseUrl: false,
    note: "Neural search, strong on papers and technical pages.",
    signupUrl: "https://exa.ai",
  },
  sonar: {
    id: "sonar",
    label: "Perplexity (Sonar)",
    key: "required",
    needsBaseUrl: false,
    note: "Returns an answer with citations as well as results.",
    signupUrl: "https://docs.perplexity.ai",
  },
  parallel: {
    id: "parallel",
    label: "Parallel",
    key: "required",
    needsBaseUrl: false,
    note: "Search API built for agents.",
    signupUrl: "https://parallel.ai",
  },
  you: {
    id: "you",
    label: "You.com",
    key: "required",
    needsBaseUrl: false,
    note: "Web and news search API.",
    signupUrl: "https://you.com/api",
  },
  tavily: {
    id: "tavily",
    label: "Tavily",
    key: "required",
    needsBaseUrl: false,
    note: "Search API built for LLM agents.",
    signupUrl: "https://tavily.com",
  },
};

export const MODEL_DEFAULTS = {
  // A local model writing a diagram from a whole page of context can take minutes.
  llm: { baseUrl: "https://api.openai.com/v1", model: "", timeoutSeconds: 300 },
  systemOne: { baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", timeoutSeconds: 30 },
};

export const TIMEOUT_LIMITS = { min: 5, max: 3600 };

// What the browser sees: keys never leave the server, only whether one is set.
export interface PublicEndpoint {
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  hasKey: boolean;
  keyHint: string;
}

export interface PublicSearcher {
  enabled: boolean;
  baseUrl: string;
  hasKey: boolean;
  keyHint: string;
}

export interface PublicConfig {
  llm: PublicEndpoint;
  systemOne: PublicEndpoint;
  searchers: Record<SearcherId, PublicSearcher>;
}

// A key field in an update: absent = keep, null = clear, string = set.
export type KeyUpdate = string | null | undefined;

export interface ConfigUpdate {
  llm?: { baseUrl?: string; model?: string; timeoutSeconds?: number; apiKey?: KeyUpdate };
  systemOne?: { baseUrl?: string; model?: string; timeoutSeconds?: number; apiKey?: KeyUpdate };
  searchers?: Partial<
    Record<SearcherId, { enabled?: boolean; baseUrl?: string; apiKey?: KeyUpdate }>
  >;
}

export interface TestResult {
  ok: boolean;
  message: string;
  ms: number;
  detail?: unknown;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
}

export interface SearcherResult {
  ok: boolean;
  ms: number;
  hits: SearchHit[];
  error?: string;
}
