import { type FormEvent, useState } from "react";
import { CircleUserRound, LogOut, ShieldCheck } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { AiAnalysisAccount } from "./AiAnalysisAccount";
import { BillingAccount } from "./BillingAccount";
import "./investor-hub.css";

type AuthMode = "sign-in" | "sign-up";

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function initials(name: string, email: string): string {
  const source = name.trim() || email.split("@")[0] || "U";
  const parts = source.split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "U";
}

function safeAccountReturnTo(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("returnTo" in state)) return null;
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  if (typeof returnTo !== "string" || returnTo.startsWith("//")) return null;
  return returnTo === "/ai-analysis"
    || returnTo.startsWith("/ai-analysis?")
    || returnTo.startsWith("/ai-analysis/")
    ? returnTo
    : null;
}

export default function InvestorHubPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session, isPending, error: sessionError, refetch } = authClient.useSession();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setFormError(null);
    setPassword("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);

    try {
      if (mode === "sign-up") {
        const result = await authClient.signUp.email({
          name: name.trim(),
          email: email.trim(),
          password,
        });
        if (result.error) {
          setFormError(errorMessage(result.error, "Unable to create your account."));
          return;
        }
      } else {
        const result = await authClient.signIn.email({
          email: email.trim(),
          password,
          rememberMe: true,
        });
        if (result.error) {
          setFormError(errorMessage(result.error, "Unable to sign in."));
          return;
        }
      }

      setPassword("");
      await refetch();
      const returnTo = safeAccountReturnTo(location.state);
      if (returnTo) navigate(returnTo, { replace: true });
    } catch (error) {
      setFormError(errorMessage(error, mode === "sign-up" ? "Unable to create your account." : "Unable to sign in."));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    setFormError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setFormError(errorMessage(result.error, "Unable to sign out."));
        return;
      }
      setMode("sign-in");
      setName("");
      setEmail("");
      setPassword("");
      await refetch();
    } catch (error) {
      setFormError(errorMessage(error, "Unable to sign out."));
    } finally {
      setSigningOut(false);
    }
  };

  if (isPending) {
    return (
      <section className="investor-hub-page" aria-busy="true">
        <div className="investor-hub-shell">
          <p className="investor-hub-kicker">Account</p>
          <h1>Investor Hub</h1>
          <div className="investor-hub-card investor-hub-loading">Loading your account…</div>
        </div>
      </section>
    );
  }

  if (sessionError && !session) {
    return (
      <section className="investor-hub-page">
        <div className="investor-hub-shell">
          <p className="investor-hub-kicker">Account</p>
          <h1>Investor Hub</h1>
          <div className="investor-hub-card investor-hub-status-card" role="alert">
            <CircleUserRound size={28} aria-hidden="true" />
            <div>
              <h2>Account service unavailable</h2>
              <p>We could not load your session. Your market data remains available.</p>
            </div>
            <button className="investor-hub-secondary-button" type="button" onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (session?.user) {
    const displayName = session.user.name?.trim() || session.user.email;
    return (
      <section className="investor-hub-page">
        <div className="investor-hub-shell">
          <p className="investor-hub-kicker">Account</p>
          <h1>Investor Hub</h1>
          <p className="investor-hub-intro">Manage your AI Analysis credits and reopen every completed report.</p>

          <div className="investor-hub-card investor-hub-profile-card">
            <div className="investor-hub-avatar" aria-hidden="true">
              {initials(displayName, session.user.email)}
            </div>
            <div className="investor-hub-profile-copy">
              <h2>{displayName}</h2>
              <p>{session.user.email}</p>
              <span className="investor-hub-secure-state">
                <ShieldCheck size={15} aria-hidden="true" /> Signed in
              </span>
            </div>
            <button
              className="investor-hub-secondary-button investor-hub-signout"
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
            >
              <LogOut size={16} aria-hidden="true" />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>

          {formError ? <p className="investor-hub-error" role="alert">{formError}</p> : null}
          <BillingAccount />
          <AiAnalysisAccount />
        </div>
      </section>
    );
  }

  const formLabel = mode === "sign-up" ? "Create account form" : "Sign in form";

  return (
    <section className="investor-hub-page">
      <div className="investor-hub-shell">
        <p className="investor-hub-kicker">Account</p>
        <h1>Investor Hub</h1>
        <p className="investor-hub-intro">
          Create an account to run private AI analyses and keep every completed report in one place.
        </p>

        <div className="investor-hub-card investor-hub-auth-card">
          <div className="investor-hub-mode-switch" role="group" aria-label="Account action">
            <button
              type="button"
              className={mode === "sign-in" ? "is-active" : ""}
              aria-pressed={mode === "sign-in"}
              onClick={() => changeMode("sign-in")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={mode === "sign-up" ? "is-active" : ""}
              aria-pressed={mode === "sign-up"}
              onClick={() => changeMode("sign-up")}
            >
              Create account
            </button>
          </div>

          <form
            className="investor-hub-form"
            aria-label={formLabel}
            onSubmit={(event) => void handleSubmit(event)}
          >
            {mode === "sign-up" ? (
              <label htmlFor="investor-hub-name">
                <span>Name</span>
                <input
                  id="investor-hub-name"
                  type="text"
                  name="name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={80}
                />
              </label>
            ) : null}

            <label htmlFor="investor-hub-email">
              <span>Email</span>
              <input
                id="investor-hub-email"
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            <label htmlFor="investor-hub-password">
              <span>Password</span>
              <input
                id="investor-hub-password"
                type="password"
                name="password"
                autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                aria-describedby={mode === "sign-up" ? "investor-hub-password-help" : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
                maxLength={128}
              />
              {mode === "sign-up" ? <small id="investor-hub-password-help">At least 8 characters.</small> : null}
            </label>

            {formError ? <p className="investor-hub-error" role="alert">{formError}</p> : null}

            <button className="investor-hub-primary-button" type="submit" disabled={submitting}>
              {submitting
                ? (mode === "sign-up" ? "Creating account…" : "Signing in…")
                : (mode === "sign-up" ? "Create my account" : "Sign in")}
            </button>
          </form>
        </div>

        <p className="investor-hub-footnote">
          Email verification and password recovery are not enabled in this first account release.
        </p>
      </div>
    </section>
  );
}
