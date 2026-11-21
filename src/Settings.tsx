import { useEffect, useState } from "react";
import {
  type ConfigUpdate,
  type KeyUpdate,
  type PublicConfig,
  type PublicEndpoint,
  type PublicSearcher,
  SEARCHER_IDS,
  SEARCHERS,
  type SearcherId,
  type SearcherResult,
  type TestResult,
} from "../shared/providers.ts";
import { api } from "./api.ts";

export function Settings() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getConfig().then(setConfig, (e) => setError(String(e)));
  }, []);

  if (error) return <p className="error">Couldn't reach the server: {error}</p>;
  if (!config) return <p className="muted" style={{ padding: 32 }}>Loading…</p>;

  const save = async (update: ConfigUpdate) => {
    const next = await api.saveConfig(update);
    setConfig(next);
    return next;
  };

  return (
    <main className="settings">
      <header>
        <a href="#" className="back">← Canvas</a>
        <h1>Settings</h1>
        <p className="muted">
          Keys are stored on this machine by the local server and never sent to the browser.
        </p>
      </header>

      <EndpointSection
        which="llm"
        title="Language model"
        blurb="Writes explanations and quizzes. Any OpenAI-compatible endpoint: OpenAI, Anthropic, OpenRouter, LiteLLM, Ollama, vLLM."
        endpoint={config.llm}
        baseUrlHint="https://api.openai.com/v1"
        modelHint="e.g. gpt-5.5, claude-sonnet-5-5, llama3"
        keyOptional
        onSave={save}
        onTest={api.testLlm}
      />

      <EndpointSection
        which="systemOne"
        title="System One decision model"
        blurb="Fast typed decisions: does this term climb, which route down, did this answer show understanding. Speaks the System One API (POST /systemone), e.g. TypeSafe Jev or a LiteLLM proxy."
        endpoint={config.systemOne}
        baseUrlHint="https://api.typesafe.ai/v1"
        modelHint="jev-latest"
        keyOptional
        onSave={save}
        onTest={api.testSystemOne}
      />

      <SearchersSection searchers={config.searchers} onSave={save} />
    </main>
  );
}

function keyUpdate(draft: string, clear: boolean): KeyUpdate {
  if (clear) return null;
  return draft.trim() ? draft.trim() : undefined;
}

function KeyField(props: {
  hasKey: boolean;
  keyHint: string;
  draft: string;
  clear: boolean;
  onDraft: (v: string) => void;
  onClear: (v: boolean) => void;
  required: boolean;
}) {
  const { hasKey, keyHint, draft, clear, onDraft, onClear, required } = props;
  const placeholder = clear
    ? "Will be removed on save"
    : hasKey
      ? `Saved (${keyHint}). Type to replace.`
      : required
        ? "Required"
        : "Optional";
  return (
    <div className="key-field">
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          onDraft(e.target.value);
          onClear(false);
        }}
      />
      {hasKey && !clear && (
        <button type="button" className="link" onClick={() => (onDraft(""), onClear(true))}>
          Remove
        </button>
      )}
      {clear && (
        <button type="button" className="link" onClick={() => onClear(false)}>
          Keep
        </button>
      )}
    </div>
  );
}

function Status({ result }: { result: TestResult | null }) {
  if (!result) return null;
  return (
    <div className={`status ${result.ok ? "ok" : "fail"}`}>
      <span>{result.ok ? "✓" : "✕"}</span> {result.message}
      <span className="muted"> · {result.ms} ms</span>
      {!result.ok && result.detail !== undefined && (
        <pre>{typeof result.detail === "string" ? result.detail : JSON.stringify(result.detail, null, 2)}</pre>
      )}
    </div>
  );
}

function EndpointSection(props: {
  which: "llm" | "systemOne";
  title: string;
  blurb: string;
  endpoint: PublicEndpoint;
  baseUrlHint: string;
  modelHint: string;
  keyOptional: boolean;
  onSave: (u: ConfigUpdate) => Promise<PublicConfig>;
  onTest: () => Promise<TestResult>;
}) {
  const { which, endpoint } = props;
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl);
  const [model, setModel] = useState(endpoint.model);
  const [keyDraft, setKeyDraft] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<"" | "saving" | "testing" | "models">("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsNote, setModelsNote] = useState("");

  const dirty =
    baseUrl !== endpoint.baseUrl || model !== endpoint.model || keyDraft.trim() !== "" || clearKey;

  const save = async () => {
    await props.onSave({ [which]: { baseUrl, model, apiKey: keyUpdate(keyDraft, clearKey) } });
    setKeyDraft("");
    setClearKey(false);
  };

  const run = async (kind: "saving" | "testing") => {
    setBusy(kind);
    setResult(null);
    try {
      if (dirty) await save();
      if (kind === "testing") setResult(await props.onTest());
    } catch (e) {
      setResult({ ok: false, message: String(e), ms: 0 });
    } finally {
      setBusy("");
    }
  };

  const loadModels = async () => {
    setBusy("models");
    try {
      if (dirty) await save();
      const r = await api.listModels(which);
      setModels(r.models);
      setModelsNote(r.error ? `Couldn't list models: ${r.error}` : `${r.models.length} models available`);
    } finally {
      setBusy("");
    }
  };

  const listId = `models-${which}`;
  return (
    <section className="card">
      <h2>{props.title}</h2>
      <p className="muted">{props.blurb}</p>
      <label>
        <span>Base URL</span>
        <input value={baseUrl} placeholder={props.baseUrlHint} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <label>
        <span>Model</span>
        <div className="row">
          <input list={listId} value={model} placeholder={props.modelHint} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
          <button type="button" className="secondary" disabled={!!busy} onClick={loadModels}>
            {busy === "models" ? "Loading…" : "List models"}
          </button>
        </div>
        <datalist id={listId}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {modelsNote && <small className="muted">{modelsNote}</small>}
      </label>
      <label>
        <span>API key</span>
        <KeyField
          hasKey={endpoint.hasKey}
          keyHint={endpoint.keyHint}
          draft={keyDraft}
          clear={clearKey}
          onDraft={setKeyDraft}
          onClear={setClearKey}
          required={!props.keyOptional}
        />
      </label>
      <div className="actions">
        <button type="button" disabled={!!busy} onClick={() => run("testing")}>
          {busy === "testing" ? "Testing…" : dirty ? "Save and test" : "Test"}
        </button>
        <button type="button" className="secondary" disabled={!!busy || !dirty} onClick={() => run("saving")}>
          {busy === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      <Status result={result} />
    </section>
  );
}

interface SearcherDraft {
  enabled: boolean;
  baseUrl: string;
  keyDraft: string;
  clearKey: boolean;
}

const draftOf = (s: PublicSearcher): SearcherDraft => ({
  enabled: s.enabled,
  baseUrl: s.baseUrl,
  keyDraft: "",
  clearKey: false,
});

function SearchersSection(props: {
  searchers: PublicConfig["searchers"];
  onSave: (u: ConfigUpdate) => Promise<PublicConfig>;
}) {
  const { searchers } = props;
  const [drafts, setDrafts] = useState(() =>
    Object.fromEntries(SEARCHER_IDS.map((id) => [id, draftOf(searchers[id])])) as Record<SearcherId, SearcherDraft>,
  );
  const [saving, setSaving] = useState(false);

  const isDirty = (id: SearcherId) => {
    const d = drafts[id];
    const s = searchers[id];
    return d.enabled !== s.enabled || d.baseUrl !== s.baseUrl || d.keyDraft.trim() !== "" || d.clearKey;
  };
  const dirty = SEARCHER_IDS.some(isDirty);

  const patch = (id: SearcherId, p: Partial<SearcherDraft>) =>
    setDrafts((all) => ({ ...all, [id]: { ...all[id], ...p } }));

  const save = async () => {
    setSaving(true);
    try {
      const update: ConfigUpdate = { searchers: {} };
      for (const id of SEARCHER_IDS.filter(isDirty)) {
        const d = drafts[id];
        update.searchers![id] = { enabled: d.enabled, baseUrl: d.baseUrl, apiKey: keyUpdate(d.keyDraft, d.clearKey) };
      }
      const next = await props.onSave(update);
      setDrafts(Object.fromEntries(SEARCHER_IDS.map((id) => [id, draftOf(next.searchers[id])])) as Record<SearcherId, SearcherDraft>);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <h2>Searchers</h2>
      <p className="muted">
        Where the librarian goes fishing. Enabled searchers run in parallel and results are compared side by side.
      </p>
      <div className="searchers">
        {SEARCHER_IDS.map((id) => {
          const info = SEARCHERS[id];
          const s = searchers[id];
          const d = drafts[id];
          return (
            <div key={id} className={`searcher ${d.enabled ? "on" : ""}`}>
              <label className="toggle">
                <input type="checkbox" checked={d.enabled} onChange={(e) => patch(id, { enabled: e.target.checked })} />
                <strong>{info.label}</strong>
                {info.key === "none" || info.key === "optional" ? <span className="badge">no key needed</span> : null}
              </label>
              <p className="muted small">
                {info.note}{" "}
                {info.signupUrl && (
                  <a href={info.signupUrl} target="_blank" rel="noreferrer">
                    Docs
                  </a>
                )}
              </p>
              {d.enabled && (
                <div className="fields">
                  {info.needsBaseUrl && (
                    <label>
                      <span>Base URL</span>
                      <input value={d.baseUrl} placeholder={info.defaultBaseUrl} spellCheck={false} onChange={(e) => patch(id, { baseUrl: e.target.value })} />
                    </label>
                  )}
                  {info.key !== "none" && (
                    <label>
                      <span>API key</span>
                      <KeyField
                        hasKey={s.hasKey}
                        keyHint={s.keyHint}
                        draft={d.keyDraft}
                        clear={d.clearKey}
                        onDraft={(v) => patch(id, { keyDraft: v })}
                        onClear={(v) => patch(id, { clearKey: v })}
                        required={info.key === "required"}
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="actions">
        <button type="button" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save searchers"}
        </button>
        {dirty && <span className="muted small">Unsaved changes</span>}
      </div>
      <TrySearch enabled={SEARCHER_IDS.filter((id) => searchers[id].enabled)} />
    </section>
  );
}

function TrySearch({ enabled }: { enabled: SearcherId[] }) {
  const [query, setQuery] = useState("Strichartz estimates lecture notes");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Partial<Record<SearcherId, SearcherResult>> | null>(null);

  const run = async () => {
    setBusy(true);
    setResults(null);
    try {
      setResults(await api.search(query, enabled, 5));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="try">
      <h3>Try a search</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" disabled={busy || !enabled.length || !query.trim()}>
          {busy ? "Searching…" : `Search ${enabled.length} enabled`}
        </button>
      </form>
      {!enabled.length && <p className="muted small">Enable and save at least one searcher.</p>}
      {results && (
        <div className="results">
          {Object.entries(results).map(([id, r]) => (
            <div key={id} className="result-col">
              <h4>
                {SEARCHERS[id as SearcherId].label}{" "}
                <span className={r!.ok ? "ok" : "fail"}>{r!.ok ? `${r!.hits.length} results` : "failed"}</span>
                <span className="muted small"> · {r!.ms} ms</span>
              </h4>
              {r!.error && <p className="fail small">{r!.error}</p>}
              <ol>
                {r!.hits.map((h) => (
                  <li key={h.url}>
                    <a href={h.url} target="_blank" rel="noreferrer">
                      {h.title}
                    </a>
                    <div className="muted small url">{h.url}</div>
                    <p className="small">{h.snippet.slice(0, 220)}</p>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
