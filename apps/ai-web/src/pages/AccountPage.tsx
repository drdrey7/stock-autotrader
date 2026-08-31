import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AiAnalysisViewerResponse } from "@stock-autotrader/contracts";
import { Shell } from "../components/layout/Shell";
import { AiAnalysisApiError, getAiAnalysisViewer } from "../lib/api/analysis";
import { getSession, signOut, type AuthSession } from "../lib/api/auth";

export function AccountPage() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [viewer, setViewer] = useState<AiAnalysisViewerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getSession(controller.signal), getAiAnalysisViewer(controller.signal)])
      .then(([nextSession, nextViewer]) => {
        if (!nextSession) {
          navigate("/auth?next=/account", { replace: true });
          return;
        }
        setSession(nextSession);
        setViewer(nextViewer);
      })
      .catch((nextError) => {
        if (controller.signal.aborted) return;
        if (nextError instanceof AiAnalysisApiError && nextError.status === 401) {
          navigate("/auth?next=/account", { replace: true });
          return;
        }
        setError("Account information is temporarily unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [navigate]);

  const logout = async () => {
    try { await signOut(); } finally { navigate("/", { replace: true }); }
  };

  return <Shell><main className="account-page page">
    <div className="section-kicker">Account / Settings</div>
    <h1>Your <em>workspace.</em></h1>
    {error && <p className="form-message" role="alert">{error}</p>}
    <div className="settings-list">
      <div><span>Profile</span><b>{loading ? "Loading…" : session?.user.name || "—"}</b></div>
      <div><span>Email</span><b>{loading ? "—" : session?.user.email || "—"}</b></div>
      <div><span>Analysis credits</span><b>{loading ? "—" : viewer?.creditsRemaining ?? "—"}</b></div>
      <div><span>Analyzed companies</span><b>{loading ? "—" : viewer?.ownedSymbols.length ?? "—"}</b></div>
    </div>
    <button className="switch-auth" type="button" onClick={logout}>Sign out</button>
  </main></Shell>;
}
