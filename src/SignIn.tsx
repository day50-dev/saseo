import { useState } from "react";
import { authClient } from "./session.ts";

const PROVIDER_LABEL: Record<string, string> = { github: "GitHub", google: "Google" };

/** Signing in keeps your canvases; anything made before signing in comes along. */
export function SignIn({ providers, anonymous }: { providers: string[]; anonymous: boolean }) {
  const [mode, setMode] = useState<"in" | "up">(anonymous ? "up" : "in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === "up"
        ? await authClient.signUp.email({ email, password, name: name.trim() || email.split("@")[0] })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "That didn't work.");
    else location.href = "/";
  };

  const social = providers.filter((p) => p !== "email");

  return (
    <main className="settings signin">
      <h1>Librarian</h1>
      <p className="muted">
        A research librarian with unlimited time, for following hard material from outside the field. Free and unlimited, no account needed.
      </p>
      <p>
        {anonymous
          ? "Sign in to keep your canvases. Everything you've made so far comes with you. "
          : "Sign in to keep your canvases, or "}
        {anonymous ? (
          <a href="/">Not now</a>
        ) : (
          <a href="/">try it without an account</a>
        )}
        .
      </p>
      <section className="card">
        <h2>{mode === "in" ? "Sign in" : "Create an account"}</h2>
        {social.length > 0 && (
          <div className="social">
            {social.map((p) => (
              <button
                key={p}
                type="button"
                className="secondary"
                onClick={() => authClient.signIn.social({ provider: p as "github" | "google", callbackURL: "/" })}
              >
                Continue with {PROVIDER_LABEL[p] ?? p}
              </button>
            ))}
            <p className="muted small or">or with email</p>
          </div>
        )}
        <form onSubmit={submit}>
          {mode === "up" && (
            <label>
              <span>Name</span>
              <input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label>
            <span>Email</span>
            <input type="email" required value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              autoComplete={mode === "up" ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="fail small">{error}</p>}
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
            </button>
            <button type="button" className="link" onClick={() => (setMode(mode === "in" ? "up" : "in"), setError(null))}>
              {mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
