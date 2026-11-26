import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConfigUpdate,
  type KeyUpdate,
  type PublicConfig,
  type PublicEndpoint,
  type PublicSearcher,
  type PublicTts,
  type Protocol,
  PROTOCOL_BASE_URLS,
  SEARCHER_IDS,
  SEARCHERS,
  type SearcherId,
  TIMEOUT_LIMITS,
  type SearcherResult,
  type TestResult,
} from "../shared/providers.ts";
import { api } from "./api.ts";
import { goBack, linkTo } from "./router.ts";
import { useIsAdmin } from "./session.ts";

export function Settings() {
  if (!useIsAdmin()) return <Unlock />;
  return <AdminSettings />;
}

/** Not unlocked yet: the models and keys are behind the administrator password. */
function Unlock() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (res.ok) return location.reload();
    setBusy(false);
    setError(res.status === 403 ? "That isn't the administrator password." : `Couldn't check it (HTTP ${res.status}).`);
  };
  return (
    <main className="settings">
      <a {...linkTo("/")} className="back">
        ← All canvases
      </a>
      <h1>Settings</h1>
      <p className="muted">
        The models, searchers and their keys are shared by everyone using this copy, so changing them takes the
        administrator password. Whoever runs the server finds it in <code>data/admin-password</code>, or sets it with{" "}
        <code>ADMIN_PASSWORD</code>.
      </p>
      <form className="unlock" onSubmit={submit}>
        <input type="password" autoComplete="current-password" autoFocus placeholder="Administrator password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
      {error && <p className="fail small">{error}</p>}
    </main>
  );
}

/** Lock this browser again, or change the administrator password. */
function AdminSection() {
  const [fromEnv, setFromEnv] = useState(false);
  const [next, setNext] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    fetch("/api/admin/password").then((r) => r.json()).then((b: { fromEnv: boolean }) => setFromEnv(b.fromEnv), () => {});
  }, []);
  const change = async () => {
    const res = await fetch("/api/admin/password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: next }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setNote(res.ok ? { ok: true, text: "Changed. Other browsers will need the new one." } : { ok: false, text: body.error ?? `HTTP ${res.status}` });
    if (res.ok) setNext("");
  };
  const lock = async () => {
    await fetch("/api/admin/lock", { method: "POST" });
    location.href = "/";
  };
  return (
    <section className="card admin-section">
      <h2>Administrator password</h2>
      {fromEnv ? (
        <p className="muted small">Set by ADMIN_PASSWORD on the server.</p>
      ) : (
        <div className="unlock">
          <input type="password" autoComplete="new-password" placeholder="New password (8 characters or more)" value={next} onChange={(e) => setNext(e.target.value)} />
          <button type="button" disabled={next.trim().length < 8} onClick={change}>
            Change
          </button>
        </div>
      )}
      {note && <p className={`${note.ok ? "ok" : "fail"} small`}>{note.text}</p>}
      <p>
        <button type="button" className="link" onClick={lock}>
          Lock settings in this browser
        </button>
      </p>
    </section>
  );
}

function AdminSettings() {
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

  return <SettingsForm config={config} onSave={save} />;
}

/** Sections with unsaved changes register how to save them, so one Done button can save everything. */
type Register = (name: string, save: (() => Promise<void>) | null) => void;

function SettingsForm({ config, onSave: save }: { config: PublicConfig; onSave: (u: ConfigUpdate) => Promise<PublicConfig> }) {
  const pending = useRef(new Map<string, () => Promise<void>>());
  const [unsaved, setUnsaved] = useState<string[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [doneError, setDoneError] = useState<string | null>(null);
  const register: Register = useCallback((name, fn) => {
    if (fn) pending.current.set(name, fn);
    else pending.current.delete(name);
    setUnsaved((prev) => (prev.includes(name) === Boolean(fn) ? prev : fn ? [...prev, name] : prev.filter((n) => n !== name)));
  }, []);

  // Done: save whatever is unsaved, then go back to where you came from.
  const done = async () => {
    setFinishing(true);
    setDoneError(null);
    try {
      for (const fn of [...pending.current.values()]) await fn();
      goBack();
    } catch (e) {
      setDoneError(`Couldn't save: ${e}`);
    } finally {
      setFinishing(false);
    }
  };

  return (
    <main className="settings">
      <header>
        <a {...linkTo("/")} className="back">
          ← All canvases
        </a>
        <h1>Settings</h1>
        <p className="muted">
          Keys are stored on this machine by the local server and never sent to the browser.
        </p>
      </header>

      <EndpointSection
        which="llm"
        title="Inference model"
        blurb="Reads what you point at and writes the cards, diagrams and answers. Give it a base URL, a key and a model, and say which protocol the server speaks."
        endpoint={config.llm}
        baseUrlHint="https://api.openai.com/v1"
        modelHint="e.g. gpt-5.5, claude-sonnet-5-5, llama3"
        keyOptional
        onSave={save}
        protocols
        onTest={api.testLlm}
        register={register}
      />

      <EndpointSection
        which="systemOne"
        title="Decision model"
        blurb="Fast typed decisions: does this term climb, which route down, did this answer show understanding. Speaks the System One API (POST /systemone), e.g. TypeSafe Jev or a LiteLLM proxy."
        endpoint={config.systemOne}
        baseUrlHint="https://api.typesafe.ai/v1"
        modelHint="jev-latest"
        keyOptional
        onSave={save}
        onTest={api.testSystemOne}
        register={register}
      />

      <EndpointSection
        which="diagram"
        title="Diagram model"
        blurb="Draws the SVG diagrams you ask for (in a card's chat, or on a call). Some models draw much better than they write. Leave the base URL blank to use the inference model's server, key and protocol with another model; leave both blank to use the inference model."
        endpoint={config.diagram}
        baseUrlHint="Same as the inference model"
        modelHint="Same as the inference model"
        keyOptional
        onSave={save}
        protocols
        onTest={api.testDiagram}
        register={register}
      />

      <TtsSection tts={config.tts} onSave={save} register={register} />

      <SearchersSection searchers={config.searchers} onSave={save} register={register} />

      <AdminSection />

      <div className="done-bar">
        {doneError ? (
          <span className="fail small">{doneError}</span>
        ) : (
          <span className="muted small">{unsaved.length ? `Unsaved changes: ${unsaved.join(", ")}` : "Changes are saved"}</span>
        )}
        <button type="button" disabled={finishing} onClick={done}>
          {finishing ? "Saving…" : unsaved.length ? "Save and close" : "Done"}
        </button>
      </div>
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
  which: "llm" | "systemOne" | "diagram";
  title: string;
  blurb: string;
  endpoint: PublicEndpoint;
  baseUrlHint: string;
  modelHint: string;
  keyOptional: boolean;
  /** Offer the OpenAI or Anthropic protocol (the decision model has its own). */
  protocols?: boolean;
  onSave: (u: ConfigUpdate) => Promise<PublicConfig>;
  onTest: () => Promise<TestResult>;
  register: Register;
}) {
  const { which, endpoint } = props;
  const [baseUrl, setBaseUrl] = useState(endpoint.baseUrl);
  const [protocol, setProtocol] = useState<Protocol>(endpoint.protocol);
  const [model, setModel] = useState(endpoint.model);
  const [timeout, setTimeoutSeconds] = useState(String(endpoint.timeoutSeconds));
  const [keyDraft, setKeyDraft] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<"" | "saving" | "testing" | "models">("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsNote, setModelsNote] = useState("");

  const timeoutNum = Number(timeout);
  const dirty =
    baseUrl !== endpoint.baseUrl ||
    protocol !== endpoint.protocol ||
    model !== endpoint.model ||
    (Number.isFinite(timeoutNum) && timeoutNum !== endpoint.timeoutSeconds) ||
    keyDraft.trim() !== "" ||
    clearKey;

  const save = async () => {
    const next = await props.onSave({
      [which]: {
        baseUrl,
        protocol,
        model,
        timeoutSeconds: Number.isFinite(timeoutNum) ? timeoutNum : undefined,
        apiKey: keyUpdate(keyDraft, clearKey),
      },
    });
    // The server clamps the timeout; show what it kept.
    setTimeoutSeconds(String(next[which].timeoutSeconds));
    setKeyDraft("");
    setClearKey(false);
  };
  const { register } = props;
  useEffect(() => register(props.title, dirty ? save : null));

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
      {props.protocols && (
        <label>
          <span>Protocol</span>
          <select
            value={protocol}
            style={{ maxWidth: 320 }}
            onChange={(e) => {
              const next = e.target.value as Protocol;
              // Switching protocol on a provider's own address switches to the other provider's.
              if (!baseUrl || Object.values(PROTOCOL_BASE_URLS).includes(baseUrl)) setBaseUrl(which === "diagram" && !baseUrl ? "" : PROTOCOL_BASE_URLS[next]);
              setProtocol(next);
              setModels([]);
            }}
          >
            <option value="openai">OpenAI-compatible (chat completions)</option>
            <option value="anthropic">Anthropic (Messages API)</option>
          </select>
          <small className="muted">
            {protocol === "anthropic"
              ? "Anthropic's API, or a proxy that speaks it."
              : "Almost every server speaks this: OpenAI, OpenRouter, LiteLLM, Ollama, vLLM, llama.cpp, Groq, Together."}
          </small>
        </label>
      )}
      <label>
        <span>Base URL</span>
        <input value={baseUrl} placeholder={protocol === "anthropic" && props.baseUrlHint.startsWith("http") ? PROTOCOL_BASE_URLS.anthropic : props.baseUrlHint} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
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
        <span>Timeout (seconds)</span>
        <input
          type="number"
          min={TIMEOUT_LIMITS.min}
          max={TIMEOUT_LIMITS.max}
          value={timeout}
          onChange={(e) => setTimeoutSeconds(e.target.value)}
          style={{ maxWidth: 140 }}
        />
        <small className="muted">
          How long to wait for one answer. A local model writing from a whole page of context can need several minutes.
        </small>
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

/** Speaking aloud on a call: any OpenAI-compatible text-to-speech server. */
function TtsSection(props: { tts: PublicTts; onSave: (u: ConfigUpdate) => Promise<PublicConfig>; register: Register }) {
  const { tts, register } = props;
  const [baseUrl, setBaseUrl] = useState(tts.baseUrl);
  const [model, setModel] = useState(tts.model);
  const [voice, setVoice] = useState(tts.voice);
  const [keyDraft, setKeyDraft] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<"" | "saving" | "testing">("");
  const [result, setResult] = useState<TestResult | null>(null);
  const dirty = baseUrl !== tts.baseUrl || model !== tts.model || voice !== tts.voice || keyDraft.trim() !== "" || clearKey;
  const save = async () => {
    await props.onSave({ tts: { baseUrl, model, voice, apiKey: keyUpdate(keyDraft, clearKey) } });
    setKeyDraft("");
    setClearKey(false);
  };
  useEffect(() => register("Speech", dirty ? save : null));
  const run = async (kind: "saving" | "testing") => {
    setBusy(kind);
    setResult(null);
    try {
      if (dirty) await save();
      if (kind === "testing") setResult(await api.testTts());
    } catch (e) {
      setResult({ ok: false, message: String(e), ms: 0 });
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="card">
      <h2>Speech</h2>
      <p className="muted">
        The librarian's voice on a call. Any OpenAI-compatible text-to-speech server (POST /audio/speech): Kokoro run
        yourself, OpenAI, and others. Leave the base URL blank and calls use the browser's own voice.
      </p>
      <label>
        <span>Base URL</span>
        <input value={baseUrl} placeholder="http://localhost:8880/v1" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <label>
        <span>Model</span>
        <input value={model} placeholder="e.g. kokoro, gpt-4o-mini-tts (optional for Kokoro)" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label>
        <span>Voice</span>
        <input value={voice} placeholder="e.g. af_heart (Kokoro), alloy (OpenAI)" spellCheck={false} onChange={(e) => setVoice(e.target.value)} />
      </label>
      <label>
        <span>API key</span>
        <KeyField hasKey={tts.hasKey} keyHint={tts.keyHint} draft={keyDraft} clear={clearKey} onDraft={setKeyDraft} onClear={setClearKey} required={false} />
      </label>
      <div className="actions">
        <button type="button" disabled={!!busy || !baseUrl} onClick={() => run("testing")}>
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
  register: Register;
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
  const { register } = props;
  useEffect(() => register("Searchers", dirty ? save : null));

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
