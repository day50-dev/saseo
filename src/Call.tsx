// A call with the librarian: just talk while you point at anything on the canvas (a piece of a
// diagram, a card, words you've selected). No button: the microphone stays open and hears when
// you start and stop speaking, so your hand stays on the document. It answers aloud, and grows
// or opens cards as it goes.
import { useEffect, useRef, useState } from "react";
import { substantive } from "../shared/canvas.ts";
import { withoutEcho } from "./echo.ts";
import { selectedText, textWithTex } from "./MathText.tsx";

type Turn = { role: "you" | "librarian"; text: string };
type State = "starting" | "listening" | "talking" | "hearing" | "thinking" | "speaking" | "muted";

export interface Pointing {
  cardId?: string;
  key?: string;
  pieceText?: string;
  selection?: string;
  /** The sentence or line the selection sits in, so "this part" can be read in place. */
  selectionContext?: string;
}

const PIECE = "[data-a], [data-x]";

/** An element's words (with its math as TeX), leaving out buttons like a piece's "+". */
function plain(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const b of [...copy.querySelectorAll("button")]) b.remove();
  return textWithTex(copy).replace(/\s+/g, " ").trim();
}

/** What's being pointed at: the selection if there is one, else the piece under the pointer. */
function pointingAt(hovered: Element | null): Pointing {
  const sel = window.getSelection();
  const node = sel && !sel.isCollapsed && sel.anchorNode ? (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement) : null;
  // Words selected in the call bar itself aren't about the canvas.
  const anchor = node && !node.closest(".call-bar") ? node : null;
  const text = anchor && sel ? selectedText(sel).replace(/\s+/g, " ").trim().slice(0, 1500) : "";
  const line = anchor?.closest(".sem-step, .sem-desc, .sem-part, .sem-together, .sem-aside, .facet p, .chat-text, .source-para, p, li");
  const context = line ? plain(line).slice(0, 800) : "";
  const el = (text ? anchor : null) ?? hovered;
  const card = el?.closest<HTMLElement>(".card-item");
  const selected = text ? { selection: text, ...(context && context !== text ? { selectionContext: context } : {}) } : {};
  if (!card) return selected;
  const piece = el?.closest<HTMLElement>(PIECE);
  const key = piece?.dataset.a ?? piece?.dataset.x;
  // Section headings ("cat-why") count as pieces; the title and decorations don't.
  const usable = key && key !== "title" && key !== "aside" ? key : undefined;
  return {
    cardId: card.dataset.cardId,
    ...(usable ? { key: usable, pieceText: plain(piece!).slice(0, 500) } : {}),
    ...selected,
  };
}

// ---- Hearing speech in an open microphone ----
// Loudness against a running estimate of the room's noise: speech starts when it's well above
// for a moment, and ends after a pause. A little audio from before the start is kept, so the
// first word isn't clipped. The audio goes out as 16 kHz mono WAV.

// The browser's own recognizer (Chrome, Edge, Safari), when there is one: no audio leaves for our
// servers, and words show as they're said.
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onspeechstart: (() => void) | null;
};
/** Whether a call can happen here: something to hear you, and something to speak. */
export const canCallWith = (server?: { tts: boolean; stt: boolean }) =>
  Boolean((browserSTT() || server?.stt) && (server?.tts || "speechSynthesis" in window));

const browserSTT = () => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

const FRAME = 2048;
const PRE_ROLL_MS = 350;
const START_MS = 120; // this long above the threshold starts an utterance
const END_MS = 900; // this long of quiet ends it
const MIN_MS = 350; // shorter than this is a cough or a click

function wav(chunks: Float32Array[], rate: number): Blob {
  const out = 16000;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const n = Math.floor((total * out) / rate);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, out, true);
  v.setUint32(28, out * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, all[Math.floor((i * rate) / out)]));
    v.setInt16(44 + i * 2, s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

type Voice = "server" | "browser";
const VOICE_KEY = "librarian.callVoice";

export function CallBar({
  canvasId,
  serverVoice,
  onChanged,
  onClose,
}: {
  canvasId: string;
  serverVoice: boolean;
  /** The canvas changed; `removed` is what the librarian took off it (for Undo). */
  onChanged: (removed?: string[]) => void;
  onClose: () => void;
}) {
  // The librarian's voice: the browser's own (instant) or the server's (Kokoro; nicer, slower).
  const [voice, setVoice] = useState<Voice>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(VOICE_KEY);
    } catch {}
    // The browser's voice by default: old-fashioned, but it starts speaking at once.
    return serverVoice && saved === "server" ? "server" : "browser";
  });
  const pickVoice = (v: Voice) => {
    setVoice(v);
    try {
      localStorage.setItem(VOICE_KEY, v);
    } catch {}
  };
  const [state, setState] = useState<State>("starting");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pointed, setPointed] = useState<Pointing>({});
  const [level, setLevel] = useState(0);
  const hovered = useRef<Element | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const stateRef = useRef<State>("starting");
  stateRef.current = state;
  const muted = useRef(false);
  // What you pointed at while saying it: the last thing on a card, during the utterance.
  const during = useRef<Pointing | null>(null);
  // The last words selected, and when: a selection made just before speaking counts even if a
  // click has since cleared it.
  const lastSel = useRef<{ p: Pointing; at: number } | null>(null);
  const startedAt = useRef(0);
  /** What an utterance was about: the selection first (now, or made shortly before), else the pointer. */
  const about = (pointer: Pointing | null): Pointing => {
    const now = pointingAt(hovered.current);
    if (now.selection) return now;
    const last = lastSel.current;
    if (last && last.at >= startedAt.current - 15_000) return last.p;
    return pointer ?? now;
  };
  // Utterances are answered one at a time, in order.
  const queue = useRef<Promise<void>>(Promise.resolve());

  // Follow the pointer, outlining the piece it's on, so it's clear what "this" will mean.
  useEffect(() => {
    let lit: Element | null = null;
    const move = (e: PointerEvent) => {
      const t = (e.target as Element | null)?.closest?.(PIECE) ?? (e.target as Element | null)?.closest?.(".card-item") ?? null;
      if (!t || !t.closest(".card-item")) return;
      hovered.current = e.target as Element;
      if (lit !== t) {
        lit?.classList.remove("call-pointed");
        t.classList.add("call-pointed");
        lit = t;
      }
      const p = pointingAt(hovered.current);
      setPointed(p);
      if (during.current && p.cardId) during.current = p;
    };
    // Selecting words shows at once what "this" now means.
    const selected = () => {
      const p = pointingAt(hovered.current);
      if (p.selection) {
        lastSel.current = { p, at: Date.now() };
        setPointed(p);
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("selectionchange", selected);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("selectionchange", selected);
      lit?.classList.remove("call-pointed");
    };
  }, []);

  /** Stops the librarian mid-sentence, whichever voice it's using. */
  const hush = () => {
    audio.current?.pause();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  };

  const speak = async (text: string) => {
    setState("speaking");
    if (voice === "browser") {
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = navigator.language || "en-US";
        u.rate = 1.05;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      });
      return;
    }
    try {
      const r = await fetch("/api/speech/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      audio.current?.pause();
      const a = new Audio(url);
      audio.current = a;
      await new Promise<void>((resolve) => {
        a.onended = () => resolve();
        a.onerror = () => resolve();
        a.onpause = () => resolve();
        a.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Couldn't speak: ${e}`);
    }
  };

  const heard = async (said: Blob | string, pointing: Pointing) => {
    setState("hearing");
    try {
      let text = typeof said === "string" ? said : "";
      if (typeof said !== "string") {
        const l = await fetch(`/api/speech/listen?cid=${encodeURIComponent(canvasId)}`, { method: "POST", body: said });
        const r = (await l.json()) as { text?: string; error?: string };
        if (r.error) throw new Error(r.error);
        text = yours(r.text ?? "");
      }
      if (!substantive(text)) return;
      const history = turnsRef.current;
      setTurns([...history, { role: "you", text }]);
      setState("thinking");
      const r = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, pointing, history }),
      });
      const { say, did, removed } = (await r.json()) as { say: string; did?: string; removed?: string[] };
      if (!say) return;
      setTurns((t) => [...t, { role: "librarian", text: say }]);
      // Its words count as echo while it speaks, and for a few seconds after (the recognizer is late).
      const spoken = { text: say, until: Infinity };
      speaking.current = [...speaking.current.filter((x) => x.until > Date.now()), spoken].slice(-3);
      echoClear.current = () => (spoken.until = Date.now() + 4000);
      if (did) onChanged(removed);
      await speak(say);
      echoClear.current();
    } catch (e) {
      setError(String(e));
    } finally {
      setState(muted.current ? "muted" : "listening");
    }
  };

  // What the librarian has just said, so the recognizer can tell its voice from yours.
  const speaking = useRef<{ text: string; until: number }[]>([]);
  const echoClear = useRef<() => void>(() => {});
  const echoes = () => speaking.current.filter((x) => x.until > Date.now()).map((x) => x.text);
  /** What was heard, without the librarian's own voice in it. */
  const yours = (heard: string) => {
    const said = echoes();
    return said.length ? withoutEcho(heard, said) : heard.trim();
  };
  const [BrowserSTT] = useState(browserSTT);
  const [interim, setInterim] = useState("");

  // The browser's recognizer, listening the whole call.
  useEffect(() => {
    if (!BrowserSTT) return;
    let stopped = false;
    const rec = new BrowserSTT();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onspeechstart = () => {
      if (muted.current) return;
      startedAt.current = Date.now();
      during.current = pointingAt(hovered.current);
    };
    rec.onresult = (e) => {
      if (muted.current) return;
      let fin = "";
      let part = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else part += r[0].transcript;
      }
      const talking = stateRef.current === "speaking";
      const live = yours(fin || part);
      if (live) {
        if (!during.current) {
          startedAt.current = Date.now();
          during.current = pointingAt(hovered.current);
        }
        // Talking over the librarian stops it.
        if (talking && live.split(/\s+/).length >= 2) hush();
        setInterim(part.trim());
        if (stateRef.current === "listening") setState("talking");
      }
      if (!fin.trim()) return;
      const text = yours(fin);
      // Noise, a stray syllable, or nothing: not a question. Back to listening, quietly.
      if (!substantive(text)) {
        setInterim("");
        during.current = null;
        setState((st) => (st === "talking" ? "listening" : st));
        return;
      }
      setInterim("");
      const pointing = about(during.current);
      during.current = null;
      queue.current = queue.current.then(() => heard(text, pointing));
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stopped = true;
        setError("The browser didn't allow the microphone.");
      }
    };
    // It stops by itself after a while; for the whole call it keeps being restarted.
    rec.onend = () => {
      if (!stopped) setTimeout(() => !stopped && rec.start(), 100);
    };
    rec.start();
    setState("listening");
    return () => {
      stopped = true;
      rec.abort();
      hush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Without one: an open microphone, sent to the server's recognizer.
  useEffect(() => {
    if (BrowserSTT) return;
    let stopped = false;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        setError("The browser didn't allow the microphone.");
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(FRAME, 1, 1);
      const rate = ctx.sampleRate;
      const frameMs = (FRAME / rate) * 1000;
      const pre: Float32Array[] = [];
      let floor = 0.005;
      let above = 0;
      let quiet = 0;
      let speech: Float32Array[] | null = null;
      let shown = 0;
      proc.onaudioprocess = (ev) => {
        const x = new Float32Array(ev.inputBuffer.getChannelData(0));
        let sum = 0;
        for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
        const rms = Math.sqrt(sum / x.length);
        const now = performance.now();
        if (now - shown > 80) {
          shown = now;
          setLevel(Math.min(1, rms / 0.15));
        }
        if (muted.current) {
          speech = null;
          above = 0;
          return;
        }
        // While the librarian talks, it takes clearly louder speech to cut in (its own voice
        // mostly comes back cancelled, but not entirely).
        const talking = stateRef.current === "speaking";
        const threshold = Math.max(floor * 3.5, 0.012) * (talking ? 2.5 : 1);
        if (!speech) {
          // The noise floor follows the room: quickly down, slowly up.
          floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.995 + rms * 0.005;
          pre.push(x);
          while (pre.length * frameMs > PRE_ROLL_MS) pre.shift();
          above = rms > threshold ? above + frameMs : 0;
          if (above >= START_MS) {
            speech = [...pre];
            quiet = 0;
            startedAt.current = Date.now();
            during.current = pointingAt(hovered.current);
            if (talking) hush(); // talking over the librarian stops it
            setState("talking");
          }
          return;
        }
        speech.push(x);
        quiet = rms > threshold * 0.7 ? 0 : quiet + frameMs;
        const long = speech.length * frameMs;
        if (quiet >= END_MS || long > 60_000) {
          const said = speech;
          speech = null;
          above = 0;
          const pointing = about(during.current);
          during.current = null;
          if (long - quiet < MIN_MS) {
            setState((s) => (s === "talking" ? "listening" : s));
            return;
          }
          const blob = wav(said, rate);
          queue.current = queue.current.then(() => heard(blob, pointing));
        }
      };
      src.connect(proc);
      // A ScriptProcessor only runs while connected to an output; it writes silence.
      proc.connect(ctx.destination);
      setState("listening");
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      hush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMute = () => {
    muted.current = !muted.current;
    if (stateRef.current === "listening" || stateRef.current === "talking" || stateRef.current === "muted") setState(muted.current ? "muted" : "listening");
  };

  // M mutes and unmutes (not while typing somewhere).
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA"].includes(t.tagName));
    const down = (e: KeyboardEvent) => {
      if ((e.key === "m" || e.key === "M") && !e.repeat && !e.metaKey && !e.ctrlKey && !typing(e.target)) toggleMute();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  });

  const where = pointed.selection ? `your selection “${pointed.selection.slice(0, 50)}${pointed.selection.length > 50 ? "…" : ""}”` : pointed.pieceText ? `“${pointed.pieceText.slice(0, 50)}…”` : "";
  const status = {
    starting: "Opening the microphone…",
    listening: where ? `Listening. Pointing at ${where}` : "Listening. Just talk, and point at what you mean",
    talking: where ? `Hearing you, about ${where}` : "Hearing you…",
    hearing: BrowserSTT ? "Got it…" : "Working out what you said…",
    thinking: "Thinking…",
    speaking: "Speaking (talk to interrupt)",
    muted: "Muted (M to unmute)",
  }[state];

  return (
    <div className="call-bar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="call-log">
        {turns.slice(-4).map((t, i) => (
          <div key={i} className={`call-turn ${t.role}`}>
            <span className="call-who">{t.role === "you" ? "You" : "Librarian"}</span> {t.text}
          </div>
        ))}
        {!turns.length && (
          <div className="call-turn muted">
            Just talk. Keep your hand on the canvas: point at a piece and say “break this down”, “why?”, or “what does this word mean?”.
          </div>
        )}
      </div>
      {/* What's happening, on a line of its own so it's never squeezed out by the buttons. */}
      <div className="call-status-line">
        <span className="call-status">
          {(state === "hearing" || state === "thinking" || state === "starting") && <span className="spinner" />} {status}
          {interim && <i className="call-interim">“{interim}”</i>}
        </span>
        {error && <span className="call-error">{error}</span>}
      </div>
      <div className="call-controls">
        <span className={`call-mic ${state}`} title={state === "muted" ? "Muted" : "The microphone is open"}>
          <span className="call-level" style={{ transform: `scaleY(${state === "muted" ? 0.08 : Math.max(0.08, level)})` }} />
        </span>
        {serverVoice && "speechSynthesis" in window ? (
          <select
            className="call-voice"
            value={voice}
            onChange={(e) => pickVoice(e.target.value as Voice)}
            title="The librarian's voice: the browser's starts at once; the natural one sounds better but takes a moment"
          >
            <option value="browser">Browser voice</option>
            <option value="server">Natural voice</option>
          </select>
        ) : (
          <span className="call-spacer" />
        )}
        <button type="button" className="secondary call-mute" onClick={toggleMute} title="Mute or unmute (M)">
          {state === "muted" ? "Unmute" : "Mute"} <kbd>M</kbd>
        </button>
        <button type="button" className="call-end" onClick={onClose} title="Hang up">
          Hang up
        </button>
      </div>
    </div>
  );
}
