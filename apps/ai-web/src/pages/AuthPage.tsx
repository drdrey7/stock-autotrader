import { ArrowUpRight } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Shell } from "../components/layout/Shell";
import { AuthApiError, signIn, signUp } from "../lib/api/auth";

function authMessage(error: unknown): string {
  if (error instanceof AuthApiError) {
    if (error.status === 401) return "Email or password is incorrect.";
    if (error.status === 409 || error.code.toLowerCase().includes("exist")) return "An account already exists for this email.";
    if (error.status >= 500) return "Authentication is temporarily unavailable. Try again shortly.";
    return error.code.replaceAll("_", " ");
  }
  return "Could not complete authentication. Check your connection and try again.";
}

function safeReturnPath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/app";

  try {
    const parsed = new URL(next, window.location.origin);
    if (parsed.origin !== window.location.origin) return "/app";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/app";
  }
}

export function AuthPage() {
  const [signup, setSignup] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const next = new URLSearchParams(location.search).get("next");
  const destination = safeReturnPath(next);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    setSubmitting(true);
    try {
      if (signup) await signUp(name.trim() || email.split("@", 1)[0] || "Investor", email.trim(), password);
      else await signIn(email.trim(), password);
      navigate(destination, { replace: true });
    } catch (error) {
      setMessage(authMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return <Shell><main className="auth-page page">
    <div className="auth-intro">
      <div className="section-kicker">{signup ? "Create account" : "Welcome back"}</div>
      <h1>Make room for<br/><em>better research.</em></h1>
      <p>Sign in to keep your analysis workspace in one place.</p>
    </div>
    <form className="auth-form" onSubmit={submit}>
      <h2>{signup ? "Create your workspace" : "Sign in"}</h2>
      {signup && <label>Name<input type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name"/></label>}
      <label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com"/></label>
      <label>Password<input type="password" required minLength={8} autoComplete={signup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••"/></label>
      <button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Please wait…" : signup ? "Create account" : "Sign in"} <ArrowUpRight size={17}/></button>
      {message && <p className="form-message" role="alert">{message}</p>}
      <button type="button" className="switch-auth" onClick={() => { setSignup(!signup); setMessage(null); }}>{signup ? "Already have an account? Sign in" : "Need an account? Create one"}</button>
    </form>
    <Link className="text-link" to="/">Back to home</Link>
  </main></Shell>;
}
