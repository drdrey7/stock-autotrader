import { useCallback, useEffect, useState } from "react";
import { CalendarClock, CreditCard, ExternalLink, RefreshCcw } from "lucide-react";
import {
  createCheckout,
  createPortal,
  getBillingStatus,
  type BillingInterval,
  type BillingStatus,
} from "./billing-api";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormatter.format(date);
}
function statusLabel(status: string): string {
  return status.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function BillingAccount() {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [action, setAction] = useState<BillingInterval | "portal" | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    void getBillingStatus(signal)
      .then(setBilling)
      .catch(() => {
        if (!signal?.aborted) setError(true);
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const redirectToCheckout = async (interval: BillingInterval) => {
    setAction(interval);
    setError(false);
    try {
      window.location.assign(await createCheckout(interval));
    } catch {
      setError(true);
      setAction(null);
    }
  };

  const redirectToPortal = async () => {
    setAction("portal");
    setError(false);
    try {
      window.location.assign(await createPortal());
    } catch {
      setError(true);
      setAction(null);
    }
  };

  const subscription = billing?.subscription;
  const periodEnd = formatDate(subscription?.currentPeriodEnd ?? null);

  return (
    <section className="investor-billing" aria-labelledby="investor-billing-title">
      <div className="investor-ai-heading">
        <div>
          <p className="investor-hub-kicker">Membership</p>
          <h2 id="investor-billing-title">Plan & billing</h2>
          <p>Stripe securely handles payment details, invoices, and subscription changes.</p>
        </div>
      </div>

      <div className="investor-hub-card investor-billing-card" aria-busy={loading}>
        <span className="investor-billing-icon" aria-hidden="true"><CreditCard size={20} /></span>
        <div className="investor-billing-copy">
          {loading && !billing ? <><span>Current plan</span><strong>Checking…</strong></> : null}
          {!loading && billing && !subscription ? <><span>Current plan</span><strong>Free</strong></> : null}
          {!loading && subscription ? (
            <>
              <span>{subscription.interval ? `${statusLabel(subscription.interval)} plan` : "Paid plan"}</span>
              <strong>{statusLabel(subscription.status)}</strong>
              {periodEnd ? (
                <small>
                  <CalendarClock size={13} aria-hidden="true" />
                  {subscription.cancelAtPeriodEnd ? `Access until ${periodEnd}` : `Renews ${periodEnd}`}
                </small>
              ) : null}
            </>
          ) : null}
          {!loading && !billing ? <><span>Current plan</span><strong>Unavailable</strong></> : null}
        </div>

        {!loading && billing?.configured && !subscription ? (
          <div className="investor-billing-actions" aria-label="Choose billing interval">
            <button
              className="investor-hub-primary-button"
              type="button"
              disabled={action !== null}
              onClick={() => void redirectToCheckout("monthly")}
            >
              {action === "monthly" ? "Opening…" : "Choose monthly"}
            </button>
            <button
              className="investor-hub-secondary-button"
              type="button"
              disabled={action !== null}
              onClick={() => void redirectToCheckout("annual")}
            >
              {action === "annual" ? "Opening…" : "Choose annual"}
            </button>
          </div>
        ) : null}

        {!loading && subscription ? (
          <button
            className="investor-hub-secondary-button"
            type="button"
            disabled={action !== null}
            onClick={() => void redirectToPortal()}
          >
            <ExternalLink size={15} aria-hidden="true" />
            {action === "portal" ? "Opening…" : "Manage billing"}
          </button>
        ) : null}

        {error ? (
          <button className="investor-hub-text-button" type="button" onClick={() => load()}>
            <RefreshCcw size={13} aria-hidden="true" /> Retry
          </button>
        ) : null}
      </div>

      {!loading && billing && !billing.configured ? (
        <p className="investor-billing-note">Paid plans are not available yet.</p>
      ) : null}
      {error ? <p className="investor-hub-error" role="alert">Billing is temporarily unavailable. Your account is unchanged.</p> : null}
    </section>
  );
}
