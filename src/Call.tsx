// A call with the librarian: hold to talk while pointing at anything on the canvas (a piece of
// a diagram, a card, words you've selected). It answers aloud, and grows or opens cards as it goes.
import { useEffect, useRef, useState } from "react";

type Turn = { role: "you" | "librarian"; text: string };
type State = "idle" | "listening" | "hearing" | "thinking" | "speaking";

export interface Pointing {
  cardId?: string;
  key?: string;
  pieceText?: string;
  selection?: string;
}

const PIECE = "[data-a], [data-x]";

/** What's being pointed at: the selection if there is one, else the piece under the pointer. */
function pointingAt(hovered: Element | null): Pointing {
  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const anchor = text && sel?.anchorNode ? (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement) : null;
  const el = anchor ?? hovered;
  const card = el?.closest<HTMLElement>(".card-item");
  if (!card) return text ? { selection: text } : {};
  const piece = el?.closest<HTMLElement>(PIECE);
  const key = piece?.dataset.a ?? piece?.dataset.x;
  // Section headings ("cat-why") count as pieces; the title and decorations don't.
  const usable = key && key !== "title" && key !== "aside" ? key : undefined;
  return {
    cardId: card.dataset.cardId,
    ...(usable ? { key: usable, pieceText: piece!.innerText.replace(/\s+/g, " ").trim().slice(0, 500) } : {}),
    ...(text ? { selection: text } : {}),
  };
}

export function CallBar({ canvasId, onChanged, onClose }: { canvasId: string; onChanged: () => void; onClose: () => void }) {
  const [state, setState] = useState<State>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pointed, setPointed] = useState<Pointing>({});
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const hovered = useRef<Element | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

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
      setPointed(pointingAt(hovered.current));
    };
    document.addEventListener("pointermove", move);
    return () => {
      document.removeEventListener("pointermove", move);
      lit?.classList.remove("call-pointed");
    };
  }, []);

  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((t) => t.stop());
      audio.current?.pause();
    },
    [],
  );

  const speak = async (text: string) => {
    setState("speaking");
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
        a.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Couldn't speak: ${e}`);
    }
    setState("idle");
  };

  const start = async () => {
    if (state !== "idle") {
      // Talking over the librarian stops it.
      if (state === "speaking") audio.current?.pause();
      else return;
    }
    setError(null);
    try {
      stream.current ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("The browser didn't allow the microphone.");
      return;
    }
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream.current);
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => void heard(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
    r.start();
    rec.current = r;
    setState("listening");
  };

  const stop = () => {
    if (rec.current?.state === "recording") rec.current.stop();
    rec.current = null;
  };

  const heard = async (blob: Blob) => {
    const pointing = pointingAt(hovered.current);
    setState("hearing");
    try {
      const l = await fetch(`/api/speech/listen?cid=${encodeURIComponent(canvasId)}`, { method: "POST", body: blob });
      const { text, error: err } = (await l.json()) as { text?: string; error?: string };
      if (err) throw new Error(err);
      if (!text) {
        setState("idle");
        setError("I didn't hear anything. Hold the button while you talk.");
        return;
      }
      const history = turnsRef.current;
      setTurns([...history, { role: "you", text }]);
      setState("thinking");
      const r = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, pointing, history }),
      });
      const { say, did } = (await r.json()) as { say: string; did?: string };
      setTurns((t) => [...t, { role: "librarian", text: say }]);
      if (did) onChanged();
      await speak(say);
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  };

  // Hold T (or the button) to talk, like a walkie-talkie; not while typing somewhere.
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA"].includes(t.tagName));
    const down = (e: KeyboardEvent) => {
      if ((e.key === "t" || e.key === "T") && !e.repeat && !typing(e.target)) void start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "t" || e.key === "T") stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  const status = {
    idle: pointed.selection ? `Pointing at “${pointed.selection.slice(0, 40)}”` : pointed.pieceText ? `Pointing at “${pointed.pieceText.slice(0, 50)}…”` : "Point at anything, then hold to talk",
    listening: "Listening… let go when you're done",
    hearing: "Hearing you…",
    thinking: "Thinking…",
    speaking: "Speaking (talk to interrupt)",
  }[state];

  return (
    <div className="call-bar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="call-log">
        {turns.slice(-4).map((t, i) => (
          <div key={i} className={`call-turn ${t.role}`}>
            <span className="call-who">{t.role === "you" ? "You" : "Librarian"}</span> {t.text}
          </div>
        ))}
        {!turns.length && <div className="call-turn muted">Ask anything about what's on the canvas. Point at a piece and say “break this down”, “why?”, or “what does this word mean?”.</div>}
      </div>
      <div className="call-controls">
        <button
          type="button"
          className={`call-talk ${state}`}
          onPointerDown={(e) => {
            e.preventDefault();
            void start();
          }}
          onPointerUp={stop}
          onPointerLeave={stop}
          title="Hold to talk (or hold T)"
        >
          {state === "listening" ? "● Listening" : "Hold to talk"} <kbd>T</kbd>
        </button>
        <span className="call-status">
          {(state === "hearing" || state === "thinking") && <span className="spinner" />} {status}
        </span>
        {error && <span className="call-error">{error}</span>}
        <button type="button" className="call-end" onClick={onClose} title="Hang up">
          Hang up
        </button>
      </div>
    </div>
  );
}
