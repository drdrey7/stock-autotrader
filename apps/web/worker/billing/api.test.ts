import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../index";
import { handleBillingApi, type BillingApiDependencies } from "./api";
import type { BillingWebhookEvent, StripeBillingClient } from "./stripe-client";

interface StoredSubscription {
  id: string;
  userId: string;
  customerId: string;
  priceId: string | null;
  status: string;
  cancelAtPeriodEnd: number;
  currentPeriodEnd: string | null;
  eventCreated: number;
  eventId: string;
  updatedAt: string;
}

interface StoredCreditPurchase {
  userId: string;
  credits: number;
  credited: number;
}

class FakeD1 {
  readonly customers = new Map<string, string>();
  readonly subscriptions = new Map<string, StoredSubscription>();
  readonly purchases = new Map<string, StoredCreditPurchase>();
  readonly entitlements = new Map<string, { remaining: number; granted: number }>([
    ["user-1", { remaining: 0, granted: 0 }],
  ]);
  readonly events = new Map<string, { processedAt: string | null }>();

  prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        args = values;
        return statement;
      },
      first: async <T>() => {
        if (sql.includes("FROM stripe_customers WHERE user_id")) {
          const customerId = this.customers.get(String(args[0]));
          return (customerId ? { stripe_customer_id: customerId } : null) as T | null;
        }
        if (sql.includes("FROM stripe_customers WHERE stripe_customer_id")) {
          const entry = [...this.customers.entries()].find(([, customerId]) => customerId === args[0]);
          return (entry ? { user_id: entry[0] } : null) as T | null;
        }
        if (sql.includes("FROM stripe_subscriptions")) {
          const rows = [...this.subscriptions.values()].filter((row) => row.userId === args[0]);
          const row = rows.at(-1);
          return (row ? {
            stripe_subscription_id: row.id,
            stripe_price_id: row.priceId,
            status: row.status,
            cancel_at_period_end: row.cancelAtPeriodEnd,
            current_period_end: row.currentPeriodEnd,
          } : null) as T | null;
        }
        return null;
      },
      run: async () => {
        if (sql.includes("INSERT INTO stripe_customers")) {
          if (!this.customers.has(String(args[0]))) this.customers.set(String(args[0]), String(args[1]));
        } else if (sql.includes("INSERT INTO stripe_webhook_events")) {
          const eventId = String(args[0]);
          const processedAt = args.length === 5 && args[4] !== null ? String(args[4]) : null;
          if (!this.events.has(eventId)) this.events.set(eventId, { processedAt });
          else if (processedAt) this.events.set(eventId, { processedAt });
        } else if (sql.includes("INSERT INTO stripe_subscriptions")) {
          const next: StoredSubscription = {
            id: String(args[0]),
            userId: String(args[1]),
            customerId: String(args[2]),
            priceId: args[3] === null ? null : String(args[3]),
            status: String(args[4]),
            cancelAtPeriodEnd: Number(args[5]),
            currentPeriodEnd: args[6] === null ? null : String(args[6]),
            eventCreated: Number(args[7]),
            eventId: String(args[8]),
            updatedAt: String(args[10]),
          };
          const current = this.subscriptions.get(next.id);
          if (!current || current.eventCreated < next.eventCreated || (current.eventCreated === next.eventCreated && current.eventId < next.eventId)) {
            this.subscriptions.set(next.id, next);
          }
        } else if (sql.includes("INSERT INTO stripe_credit_purchases")) {
          const checkoutSessionId = String(args[0]);
          if (!this.purchases.has(checkoutSessionId)) {
            this.purchases.set(checkoutSessionId, {
              userId: String(args[1]),
              credits: Number(args[2]),
              credited: 0,
            });
          }
        } else if (sql.includes("UPDATE user_ai_entitlements")) {
          const credits = Number(args[0]);
          const userId = String(args[3]);
          const purchaseId = String(args[4]);
          const purchase = this.purchases.get(purchaseId);
          if (purchase && purchase.userId === userId && purchase.credited === 0) {
            const current = this.entitlements.get(userId) ?? { remaining: 0, granted: 0 };
            current.remaining += credits;
            current.granted += credits;
            this.entitlements.set(userId, current);
          }
        } else if (sql.includes("UPDATE stripe_credit_purchases")) {
          const purchase = this.purchases.get(String(args[0]));
          if (purchase) purchase.credited = 1;
        } else if (sql.includes("UPDATE stripe_webhook_events")) {
          // An UPDATE must NOT create an event row implicitly: the production
          // INSERT ... ON CONFLICT path is what records first-time events. An
          // UPDATE only marks a previously-inserted event processed.
          const event = this.events.get(String(args[1]));
          if (event) event.processedAt = String(args[0]);
        } else if (sql.includes("UPDATE stripe_subscriptions")) {
          // no-op: subscription upserts go through INSERT ... ON CONFLICT
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }

  async batch(statements: { run(): Promise<unknown> }[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class FakeStripe implements StripeBillingClient {
  readonly createCustomer = vi.fn(async () => ({ id: "cus_test" }));
  readonly createCheckout = vi.fn<StripeBillingClient["createCheckout"]>(async () => ({ url: "https://checkout.stripe.test/session" }));
  readonly createPortal = vi.fn(async () => ({ url: "https://billing.stripe.test/portal" }));
  readonly createCreditCheckout = vi.fn(async () => ({ url: "https://checkout.stripe.test/credits" }));
  nextEvent: BillingWebhookEvent = { id: "evt_unused", type: "ignored", created: 1, subscription: null, creditCheckout: null };
  readonly verifyWebhook = vi.fn(async () => this.nextEvent);
}

function testContext() {
  const db = new FakeD1();
  const stripe = new FakeStripe();
  const env = {
    DB: db as unknown as D1Database,
    ASSETS: {} as Fetcher,
    STRIPE_SECRET_KEY: "test-key",
    STRIPE_WEBHOOK_SECRET: "test-webhook-secret",
    STRIPE_PRICE_MONTHLY: "price_monthly",
    STRIPE_PRICE_ANNUAL: "price_annual",
    STRIPE_CREDIT_PACKS: JSON.stringify([
      { credits: 5, priceId: "price_credits_5" },
      { credits: 10, priceId: "price_credits_10" },
    ]),
  } as Env;
  const deps: BillingApiDependencies = {
    authenticate: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })),
    createStripe: () => stripe,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
  };
  return { db, stripe, env, deps };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://stock.test${path}`, init);
}

describe("Stripe billing API", () => {
  it("creates a mapped customer and a hosted monthly Checkout Session", async () => {
    const { db, stripe, env, deps } = testContext();
    const response = await handleBillingApi(request("/api/billing/checkout", {
      method: "POST",
      headers: { origin: "https://stock.test", "content-type": "application/json" },
      body: JSON.stringify({ interval: "monthly", idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" }),
    }), env, deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/session" });
    expect(db.customers.get("user-1")).toBe("cus_test");
    expect(stripe.createCheckout).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "cus_test",
      priceId: "price_monthly",
      userId: "user-1",
      successUrl: "https://stock.test/account?checkout=success",
    }));
  });

  it("rejects cross-site checkout mutations before calling Stripe", async () => {
    const { stripe, env, deps } = testContext();
    const response = await handleBillingApi(request("/api/billing/checkout", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ interval: "annual", idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" }),
    }), env, deps);

    expect(response.status).toBe(403);
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckout).not.toHaveBeenCalled();
  });

  it("creates a hosted one-time Checkout Session for AI credits", async () => {
    const { db, stripe, env, deps } = testContext();
    const response = await handleBillingApi(request("/api/billing/credits", {
      method: "POST",
      headers: { origin: "https://stock.test", "content-type": "application/json" },
      body: JSON.stringify({ packId: 5, idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" }),
    }), env, deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/credits" });
    expect(db.customers.get("user-1")).toBe("cus_test");
    expect(stripe.createCreditCheckout).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "cus_test",
      credits: 5,
      priceId: "price_credits_5",
      userId: "user-1",
      successUrl: "https://stock.test/account?credits=success",
    }));
  });

  it("selects the requested credit pack (10 credits) for checkout", async () => {
    const { stripe, env, deps } = testContext();
    const response = await handleBillingApi(request("/api/billing/credits", {
      method: "POST",
      headers: { origin: "https://stock.test", "content-type": "application/json" },
      body: JSON.stringify({ packId: 10, idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" }),
    }), env, deps);

    expect(response.status).toBe(200);
    expect(stripe.createCreditCheckout).toHaveBeenCalledWith(expect.objectContaining({
      credits: 10,
      priceId: "price_credits_10",
    }));
  });

  it("rejects a credit checkout for an unknown pack", async () => {
    const { stripe, env, deps } = testContext();
    const response = await handleBillingApi(request("/api/billing/credits", {
      method: "POST",
      headers: { origin: "https://stock.test", "content-type": "application/json" },
      body: JSON.stringify({ packId: 99, idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" }),
    }), env, deps);

    expect(response.status).toBe(503);
    expect(stripe.createCreditCheckout).not.toHaveBeenCalled();
  });

  it("rejects a credit checkout missing a pack selection", async () => {
    const { stripe, env, deps } = testContext();
    const response = await handleBillingApi(request("/api/billing/credits", {
      method: "POST",
      headers: { origin: "https://stock.test", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" }),
    }), env, deps);

    expect(response.status).toBe(400);
    expect(stripe.createCreditCheckout).not.toHaveBeenCalled();
  });

  it("reports configured credit packs in billing status", async () => {
    const { env, deps } = testContext();
    const response = await handleBillingApi(request("/api/billing/status", {
      method: "GET",
      headers: { origin: "https://stock.test" },
    }), env, deps);

    expect(response.status).toBe(200);
    const body = await response.json() as { creditsConfigured: boolean; creditPacks: Array<{ credits: number }> };
    expect(body.creditsConfigured).toBe(true);
    expect(body.creditPacks).toEqual([{ credits: 5 }, { credits: 10 }]);
  });

  it("deduplicates concurrent subscription checkouts onto a single server key", async () => {
    const { stripe, env, deps } = testContext();
    const make = (idempotencyKey: string) => request("/api/billing/checkout", {
      method: "POST",
      headers: { origin: "https://stock.test", "content-type": "application/json" },
      body: JSON.stringify({ interval: "monthly", idempotencyKey }),
    });
    const [a, b] = await Promise.all([
      handleBillingApi(make("123e4567-e89b-42d3-a456-426614174000"), env, deps),
      handleBillingApi(make("87654321-8765-4876-8876-876543210000"), env, deps),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Different client UUIDs must still map to the same server-derived key, so
    // Stripe cannot create two subscription checkouts for the same user.
    const calls = stripe.createCheckout.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe("stockai-checkout-user-1");
    expect(calls[1]).toBe("stockai-checkout-user-1");
  });

  it("stores a verified subscription event and ignores an older delivery", async () => {
    const { db, stripe, env, deps } = testContext();
    db.customers.set("user-1", "cus_test");
    stripe.nextEvent = {
      id: "evt_new",
      type: "customer.subscription.updated",
      created: 200,
      subscription: {
        id: "sub_test",
        customerId: "cus_test",
        priceId: "price_annual",
        status: "active",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: 1_800_000_000,
        userIdMetadata: "user-1",
      },
      creditCheckout: null,
    };
    const webhook = () => request("/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "valid" },
      body: "{}",
    });
    expect((await handleBillingApi(webhook(), env, deps)).status).toBe(200);

    stripe.nextEvent = {
      ...stripe.nextEvent,
      id: "evt_old",
      created: 100,
      subscription: { ...stripe.nextEvent.subscription!, status: "past_due" },
    };
    expect((await handleBillingApi(webhook(), env, deps)).status).toBe(200);
    expect(db.subscriptions.get("sub_test")?.status).toBe("active");
    expect(db.events.get("evt_new")?.processedAt).toBe("2026-08-30T12:00:00.000Z");
    expect(db.events.get("evt_old")?.processedAt).toBe("2026-08-30T12:00:00.000Z");
  });

  it("never processes a webhook with a failed signature", async () => {
    const { stripe, env, deps } = testContext();
    stripe.verifyWebhook.mockRejectedValueOnce(new Error("bad signature"));
    const response = await handleBillingApi(request("/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "invalid" },
      body: "{}",
    }), env, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
  });

  it("credits a paid AI credit checkout exactly once on webhook replay", async () => {
    const { db, stripe, env, deps } = testContext();
    db.customers.set("user-1", "cus_test");
    stripe.nextEvent = {
      id: "evt_credit",
      type: "checkout.session.completed",
      created: 300,
      subscription: null,
      creditCheckout: {
        id: "cs_credit",
        customerId: "cus_test",
        mode: "payment",
        paymentStatus: "paid",
        userIdMetadata: "user-1",
        purchaseType: "ai_credit_pack",
        credits: 5,
      },
    };

    const webhook = () => request("/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "valid" },
      body: "{}",
    });
    expect((await handleBillingApi(webhook(), env, deps)).status).toBe(200);
    expect((await handleBillingApi(webhook(), env, deps)).status).toBe(200);
    expect(db.entitlements.get("user-1")).toEqual({ remaining: 5, granted: 5 });
    expect(db.purchases.get("cs_credit")).toEqual({ userId: "user-1", credits: 5, credited: 1 });
    // A valid credit webhook is recorded in the audit table, not left missing
    // by a bare UPDATE that touches zero rows on first delivery.
    expect(db.events.get("evt_credit")?.processedAt).toBe("2026-08-30T12:00:00.000Z");
  });
});
