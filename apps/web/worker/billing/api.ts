import type { Env } from "../index";
import {
  BillingAuthUnavailableError,
  readAuthenticatedBillingUser,
  type AuthenticatedBillingUser,
} from "./session";
import {
  OfficialStripeBillingClient,
  type BillingWebhookEvent,
  type StripeBillingClient,
  type SubscriptionSnapshot,
} from "./stripe-client";

const MAX_BODY_BYTES = 1_048_576;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);
const CREDIT_PURCHASE_EVENT = "checkout.session.completed";
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

interface CreditPack {
  credits: number;
  priceId: string;
}

const MAX_CREDIT_PACK_CREDITS = 1_000_000;

/**
 * Parse the credit-pack catalog from the STRIPE_CREDIT_PACKS env secret:
 * a JSON array of { credits, priceId }. Order is preserved so the UI can
 * render cheapest-first. Rows that fail validation are dropped instead of
 * failing the request, so one malformed row cannot take down billing.
 */
function parseCreditPacks(raw: string | undefined): CreditPack[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CreditPack => {
      if (typeof entry !== "object" || entry === null) return false;
      const { credits, priceId } = entry as { credits?: unknown; priceId?: unknown };
      return Number.isInteger(credits)
        && (credits as number) > 0
        && (credits as number) <= MAX_CREDIT_PACK_CREDITS
        && typeof priceId === "string"
        && priceId.length > 0;
    });
  } catch {
    return [];
  }
}

interface CustomerRow {
  stripe_customer_id: string;
}

interface SubscriptionRow {
  stripe_subscription_id: string;
  stripe_price_id: string | null;
  status: string;
  cancel_at_period_end: number;
  current_period_end: string | null;
}

export interface BillingApiDependencies {
  authenticate(request: Request, env: Env): Promise<AuthenticatedBillingUser | null>;
  createStripe(secretKey: string): StripeBillingClient;
  now(): Date;
}

const defaultDependencies: BillingApiDependencies = {
  authenticate: readAuthenticatedBillingUser,
  createStripe: (secretKey) => new OfficialStripeBillingClient(secretKey),
  now: () => new Date(),
};

function privateJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      vary: "Cookie",
    },
  });
}

function methodNotAllowed(allow: string): Response {
  const response = privateJson({ error: "method_not_allowed" }, 405);
  response.headers.set("allow", allow);
  return response;
}

function requestOriginIsSame(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readBoundedBody(request: Request, limit: number): Promise<string | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function planForPrice(env: Env, priceId: string | null): "monthly" | "annual" | null {
  if (priceId && priceId === env.STRIPE_PRICE_MONTHLY) return "monthly";
  if (priceId && priceId === env.STRIPE_PRICE_ANNUAL) return "annual";
  return null;
}

async function readCustomer(db: D1Database, userId: string): Promise<CustomerRow | null> {
  return db.prepare("SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<CustomerRow>();
}

async function readSubscription(db: D1Database, userId: string): Promise<SubscriptionRow | null> {
  return db.prepare(`
    SELECT stripe_subscription_id, stripe_price_id, status, cancel_at_period_end, current_period_end
    FROM stripe_subscriptions
    WHERE user_id = ?
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
      updated_at DESC
    LIMIT 1
  `).bind(userId).first<SubscriptionRow>();
}

async function ensureCustomer(
  env: Env,
  stripe: StripeBillingClient,
  user: AuthenticatedBillingUser,
  now: Date,
): Promise<string> {
  const existing = await readCustomer(env.DB, user.id);
  if (existing) return existing.stripe_customer_id;

  // A stable Stripe idempotency key prevents concurrent first checkouts from
  // creating duplicate Customer objects even if both requests miss the D1 row.
  const created = await stripe.createCustomer(user.email, user.id, `stockai-customer-${user.id}`);
  const timestamp = now.toISOString();
  await env.DB.prepare(`
    INSERT INTO stripe_customers (user_id, stripe_customer_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).bind(user.id, created.id, timestamp, timestamp).run();
  const stored = await readCustomer(env.DB, user.id);
  if (!stored) throw new Error("stripe_customer_mapping_failed");
  return stored.stripe_customer_id;
}

async function handleStatus(env: Env, user: AuthenticatedBillingUser): Promise<Response> {
  const subscription = await readSubscription(env.DB, user.id);
  const creditPacks = parseCreditPacks(env.STRIPE_CREDIT_PACKS);
  return privateJson({
    configured: Boolean(
      env.STRIPE_SECRET_KEY
      && env.STRIPE_WEBHOOK_SECRET
      && env.STRIPE_PRICE_MONTHLY
      && env.STRIPE_PRICE_ANNUAL,
    ),
    // Credits are sold when at least one valid pack is configured and the
    // webhook/ledger path is present, mirroring the subscription gate.
    creditsConfigured: Boolean(
      env.STRIPE_SECRET_KEY
      && env.STRIPE_WEBHOOK_SECRET
      && creditPacks.length > 0,
    ),
    creditPacks: creditPacks.map((pack) => ({ credits: pack.credits })),
    subscription: subscription ? {
      id: subscription.stripe_subscription_id,
      status: subscription.status,
      entitled: ACTIVE_STATUSES.has(subscription.status),
      interval: planForPrice(env, subscription.stripe_price_id),
      cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
      currentPeriodEnd: subscription.current_period_end,
    } : null,
  });
}

async function handleCreditCheckout(
  request: Request,
  env: Env,
  user: AuthenticatedBillingUser,
  deps: BillingApiDependencies,
): Promise<Response> {
  if (!requestOriginIsSame(request)) return privateJson({ error: "invalid_origin" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return privateJson({ error: "invalid_request" }, 400);
  }
  const raw = await readBoundedBody(request, 2_048);
  if (raw === null) return privateJson({ error: "invalid_request" }, 400);
  let idempotencyKey: unknown;
  let packId: unknown;
  try {
    const body = JSON.parse(raw) as { idempotencyKey?: unknown; packId?: unknown };
    idempotencyKey = body.idempotencyKey;
    packId = body.packId;
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return privateJson({ error: "invalid_request" }, 400);
    }
  } catch {
    return privateJson({ error: "invalid_request" }, 400);
  }
  if (!packId) return privateJson({ error: "invalid_request" }, 400);

  const secretKey = env.STRIPE_SECRET_KEY;
  // Select the requested pack from the configured catalog.
  const pack = parseCreditPacks(env.STRIPE_CREDIT_PACKS).find((entry) => String(entry.credits) === String(packId));
  if (!secretKey || !env.STRIPE_WEBHOOK_SECRET || !pack) {
    return privateJson({ error: "credit_purchase_not_configured" }, 503);
  }
  const stripe = deps.createStripe(secretKey);
  const customerId = await ensureCustomer(env, stripe, user, deps.now());
  const origin = new URL(request.url).origin;
  const checkout = await stripe.createCreditCheckout({
    customerId,
    credits: pack.credits,
    idempotencyKey: `stockai-credits-${user.id}-${idempotencyKey}`,
    priceId: pack.priceId,
    userId: user.id,
    successUrl: `${origin}/account?credits=success`,
    cancelUrl: `${origin}/account?credits=canceled`,
  });
  return checkout.url ? privateJson({ url: checkout.url }) : privateJson({ error: "checkout_unavailable" }, 502);
}

async function parseCheckoutBody(request: Request): Promise<{ interval: "monthly" | "annual"; idempotencyKey: string } | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const raw = await readBoundedBody(request, 2_048);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { interval?: unknown; idempotencyKey?: unknown };
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !keys.includes("interval") || !keys.includes("idempotencyKey")) return null;
    if (parsed.interval !== "monthly" && parsed.interval !== "annual") return null;
    if (typeof parsed.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(parsed.idempotencyKey)) return null;
    return { interval: parsed.interval, idempotencyKey: parsed.idempotencyKey };
  } catch {
    return null;
  }
}

async function handleCheckout(
  request: Request,
  env: Env,
  user: AuthenticatedBillingUser,
  deps: BillingApiDependencies,
): Promise<Response> {
  if (!requestOriginIsSame(request)) return privateJson({ error: "invalid_origin" }, 403);
  const body = await parseCheckoutBody(request);
  if (!body) return privateJson({ error: "invalid_request" }, 400);
  const secretKey = env.STRIPE_SECRET_KEY;
  const priceId = body.interval === "monthly" ? env.STRIPE_PRICE_MONTHLY : env.STRIPE_PRICE_ANNUAL;
  // Do not sell a subscription unless the webhook read-model path is also
  // configured; otherwise payment could succeed while the product remains
  // unaware of the customer's subscription.
  if (!secretKey || !env.STRIPE_WEBHOOK_SECRET || !priceId) {
    return privateJson({ error: "billing_not_configured" }, 503);
  }
  const existing = await readSubscription(env.DB, user.id);
  if (existing && ACTIVE_STATUSES.has(existing.status)) {
    return privateJson({ error: "subscription_already_active" }, 409);
  }

  const stripe = deps.createStripe(secretKey);
  const customerId = await ensureCustomer(env, stripe, user, deps.now());
  const origin = new URL(request.url).origin;
  const checkout = await stripe.createCheckout({
    customerId,
    // Server-derived idempotency key (per user, independent of the client
    // UUID): two concurrent first checkouts for the same user resolve to the
    // SAME Checkout Session instead of minting a second subscription checkout.
    // Stripe deduplicates on idempotency key, so this both prevents duplicate
    // sessions and makes a client retry idempotent. The client UUID is still
    // validated and bound above, but is not part of the key.
    idempotencyKey: `stockai-checkout-${user.id}`,
    priceId,
    userId: user.id,
    successUrl: `${origin}/account?checkout=success`,
    cancelUrl: `${origin}/account?checkout=canceled`,
  });
  return checkout.url
    ? privateJson({ url: checkout.url })
    : privateJson({ error: "checkout_unavailable" }, 502);
}

async function handlePortal(
  request: Request,
  env: Env,
  user: AuthenticatedBillingUser,
  deps: BillingApiDependencies,
): Promise<Response> {
  if (!requestOriginIsSame(request)) return privateJson({ error: "invalid_origin" }, 403);
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return privateJson({ error: "billing_not_configured" }, 503);
  const customer = await readCustomer(env.DB, user.id);
  if (!customer) return privateJson({ error: "billing_customer_not_found" }, 404);
  const portal = await deps.createStripe(secretKey).createPortal(
    customer.stripe_customer_id,
    `${new URL(request.url).origin}/account`,
  );
  return privateJson({ url: portal.url });
}

async function markEventProcessed(
  db: D1Database,
  event: BillingWebhookEvent,
  receivedAt: string,
): Promise<void> {
  await db.prepare(`
    INSERT INTO stripe_webhook_events
      (stripe_event_id, event_type, event_created_at, received_at, processed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(stripe_event_id) DO UPDATE SET processed_at = COALESCE(stripe_webhook_events.processed_at, excluded.processed_at)
  `).bind(event.id, event.type, event.created, receivedAt, receivedAt).run();
}

async function persistSubscriptionEvent(
  db: D1Database,
  event: BillingWebhookEvent,
  subscription: SubscriptionSnapshot,
  receivedAt: string,
): Promise<void> {
  const customer = await db.prepare("SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ? LIMIT 1")
    .bind(subscription.customerId)
    .first<{ user_id: string }>();
  if (!customer) {
    await markEventProcessed(db, event, receivedAt);
    return;
  }
  if (subscription.userIdMetadata && subscription.userIdMetadata !== customer.user_id) {
    throw new Error("stripe_subscription_identity_mismatch");
  }

  const periodEnd = subscription.currentPeriodEnd === null
    ? null
    : new Date(subscription.currentPeriodEnd * 1_000).toISOString();
  const createdAt = new Date(event.created * 1_000).toISOString();
  const statements = [
    db.prepare(`
      INSERT INTO stripe_webhook_events
        (stripe_event_id, event_type, event_created_at, received_at, processed_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(stripe_event_id) DO NOTHING
    `).bind(event.id, event.type, event.created, receivedAt),
    db.prepare(`
      INSERT INTO stripe_subscriptions (
        stripe_subscription_id, user_id, stripe_customer_id, stripe_price_id,
        status, cancel_at_period_end, current_period_end,
        latest_event_created_at, latest_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stripe_subscription_id) DO UPDATE SET
        user_id = excluded.user_id,
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_price_id = excluded.stripe_price_id,
        status = excluded.status,
        cancel_at_period_end = excluded.cancel_at_period_end,
        current_period_end = excluded.current_period_end,
        latest_event_created_at = excluded.latest_event_created_at,
        latest_event_id = excluded.latest_event_id,
        updated_at = excluded.updated_at
      WHERE stripe_subscriptions.latest_event_created_at < excluded.latest_event_created_at
         OR (stripe_subscriptions.latest_event_created_at = excluded.latest_event_created_at
             AND stripe_subscriptions.latest_event_id < excluded.latest_event_id)
    `).bind(
      subscription.id,
      customer.user_id,
      subscription.customerId,
      subscription.priceId,
      subscription.status,
      subscription.cancelAtPeriodEnd ? 1 : 0,
      periodEnd,
      event.created,
      event.id,
      createdAt,
      receivedAt,
    ),
    db.prepare("UPDATE stripe_webhook_events SET processed_at = ? WHERE stripe_event_id = ?")
      .bind(receivedAt, event.id),
  ];
  await db.batch(statements);
}

async function persistCreditPurchase(
  db: D1Database,
  event: BillingWebhookEvent,
  receivedAt: string,
): Promise<void> {
  const purchase = event.creditCheckout;
  if (!purchase || purchase.mode !== "payment" || purchase.paymentStatus !== "paid" || purchase.purchaseType !== "ai_credit_pack" || !purchase.customerId || !purchase.credits) {
    await markEventProcessed(db, event, receivedAt);
    return;
  }
  const customer = await db.prepare("SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ? LIMIT 1")
    .bind(purchase.customerId)
    .first<{ user_id: string }>();
  if (!customer || (purchase.userIdMetadata && purchase.userIdMetadata !== customer.user_id)) {
    await markEventProcessed(db, event, receivedAt);
    return;
  }
  const timestamp = new Date(event.created * 1_000).toISOString();
  // The purchase row is the idempotency ledger. The second UPDATE only runs
  // while credited=0, so replaying the same Checkout event cannot mint credits
  // twice, even when Stripe retries delivery.
  await db.batch([
    db.prepare(`
      INSERT INTO stripe_webhook_events
        (stripe_event_id, event_type, event_created_at, received_at, processed_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(stripe_event_id) DO NOTHING
    `).bind(event.id, event.type, event.created, receivedAt),
    db.prepare(`
      INSERT INTO stripe_credit_purchases
        (checkout_session_id, user_id, credits, stripe_event_id, paid_at, credited, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(checkout_session_id) DO NOTHING
    `).bind(purchase.id, customer.user_id, purchase.credits, event.id, timestamp, receivedAt),
    db.prepare(`
      UPDATE user_ai_entitlements
      SET credits_remaining = credits_remaining + ?,
          credits_granted = credits_granted + ?,
          updated_at = ?
      WHERE user_id = ?
        AND EXISTS (
          SELECT 1 FROM stripe_credit_purchases
          WHERE checkout_session_id = ? AND user_id = ? AND credited = 0
        )
    `).bind(purchase.credits, purchase.credits, receivedAt, customer.user_id, purchase.id, customer.user_id),
    db.prepare("UPDATE stripe_credit_purchases SET credited = 1 WHERE checkout_session_id = ? AND credited = 0")
      .bind(purchase.id),
    db.prepare("UPDATE stripe_webhook_events SET processed_at = ? WHERE stripe_event_id = ?")
      .bind(receivedAt, event.id),
  ]);
}

async function handleWebhook(
  request: Request,
  env: Env,
  deps: BillingApiDependencies,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return privateJson({ error: "billing_not_configured" }, 503);
  const signature = request.headers.get("stripe-signature");
  if (!signature) return privateJson({ error: "invalid_signature" }, 400);
  const payload = await readBoundedBody(request, MAX_BODY_BYTES);
  if (payload === null) return privateJson({ error: "invalid_payload" }, 413);

  let event: BillingWebhookEvent;
  try {
    event = await deps.createStripe(secretKey).verifyWebhook(payload, signature, webhookSecret);
  } catch {
    return privateJson({ error: "invalid_signature" }, 400);
  }

  const receivedAt = deps.now().toISOString();
    if (SUBSCRIPTION_EVENTS.has(event.type) && event.subscription) {
      await persistSubscriptionEvent(env.DB, event, event.subscription, receivedAt);
    } else if (event.type === CREDIT_PURCHASE_EVENT && event.creditCheckout) {
      await persistCreditPurchase(env.DB, event, receivedAt);
  } else {
    await markEventProcessed(env.DB, event, receivedAt);
  }
  return privateJson({ received: true });
}

export async function handleBillingApi(
  request: Request,
  env: Env,
  deps: BillingApiDependencies = defaultDependencies,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  try {
    if (pathname === "/api/billing/webhook") return await handleWebhook(request, env, deps);
    if (request.method === "OPTIONS") return methodNotAllowed("GET, POST");

    let user: AuthenticatedBillingUser | null;
    try {
      user = await deps.authenticate(request, env);
    } catch (error) {
      if (error instanceof BillingAuthUnavailableError) return privateJson({ error: "auth_unavailable" }, 503);
      throw error;
    }
    if (!user) return privateJson({ error: "authentication_required" }, 401);

    if (pathname === "/api/billing/status") {
      return request.method === "GET" ? handleStatus(env, user) : methodNotAllowed("GET");
    }
    if (pathname === "/api/billing/checkout") {
      return request.method === "POST" ? handleCheckout(request, env, user, deps) : methodNotAllowed("POST");
    }
    if (pathname === "/api/billing/credits") {
      return request.method === "POST" ? handleCreditCheckout(request, env, user, deps) : methodNotAllowed("POST");
    }
    if (pathname === "/api/billing/portal") {
      return request.method === "POST" ? handlePortal(request, env, user, deps) : methodNotAllowed("POST");
    }
    return privateJson({ error: "not_found" }, 404);
  } catch (error) {
    console.error(JSON.stringify({
      component: "billing-api",
      path: pathname,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    }));
    return privateJson({ error: "billing_unavailable" }, 503);
  }
}
