export type BillingInterval = "monthly" | "annual";

export interface BillingStatus {
  configured: boolean;
  creditsConfigured: boolean;
  subscription: {
    id: string;
    status: string;
    entitled: boolean;
    interval: BillingInterval | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  } | null;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`billing_request_failed_${response.status}`);
  return response.json() as Promise<T>;
}

export async function getBillingStatus(signal?: AbortSignal): Promise<BillingStatus> {
  return readJson<BillingStatus>(await fetch("/api/billing/status", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  }));
}

export async function createCheckout(interval: BillingInterval): Promise<string> {
  const response = await fetch("/api/billing/checkout", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ interval, idempotencyKey: crypto.randomUUID() }),
  });
  return (await readJson<{ url: string }>(response)).url;
}

export async function createPortal(): Promise<string> {
  const response = await fetch("/api/billing/portal", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  return (await readJson<{ url: string }>(response)).url;
}

export async function createCreditCheckout(): Promise<string> {
  const response = await fetch("/api/billing/credits", {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
  return (await readJson<{ url: string }>(response)).url;
}
