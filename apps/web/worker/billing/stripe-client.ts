import Stripe from "stripe";

const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

export interface CheckoutInput {
  customerId: string;
  idempotencyKey: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  userId: string;
}

export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  priceId: string | null;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  userIdMetadata: string | null;
}

export interface BillingWebhookEvent {
  id: string;
  type: string;
  created: number;
  subscription: SubscriptionSnapshot | null;
  creditCheckout: CreditCheckoutSnapshot | null;
}

export interface CreditCheckoutSnapshot {
  id: string;
  customerId: string | null;
  mode: string | null;
  paymentStatus: string | null;
  userIdMetadata: string | null;
  purchaseType: string | null;
  credits: number | null;
}

export interface StripeBillingClient {
  createCustomer(email: string, userId: string, idempotencyKey: string): Promise<{ id: string }>;
  createCheckout(input: CheckoutInput): Promise<{ url: string | null }>;
  createCreditCheckout(input: {
    customerId: string;
    credits: number;
    idempotencyKey: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    userId: string;
  }): Promise<{ url: string | null }>;
  createPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;
  verifyWebhook(payload: string, signature: string, webhookSecret: string): Promise<BillingWebhookEvent>;
}

function subscriptionSnapshot(object: Stripe.Subscription): SubscriptionSnapshot {
  const customerId = typeof object.customer === "string" ? object.customer : object.customer.id;
  const item = object.items.data[0];
  return {
    id: object.id,
    customerId,
    priceId: item?.price?.id ?? null,
    status: object.status,
    cancelAtPeriodEnd: object.cancel_at_period_end,
    currentPeriodEnd: item?.current_period_end ?? null,
    userIdMetadata: object.metadata.better_auth_user_id ?? null,
  };
}

/** A request-scoped official Stripe SDK client; no mutable global API-key state. */
export class OfficialStripeBillingClient implements StripeBillingClient {
  private readonly client: Stripe;

  constructor(secretKey: string) {
    this.client = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  }

  async createCustomer(email: string, userId: string, idempotencyKey: string): Promise<{ id: string }> {
    return this.client.customers.create(
      { email, metadata: { better_auth_user_id: userId } },
      { idempotencyKey },
    );
  }

  async createCheckout(input: CheckoutInput): Promise<{ url: string | null }> {
    return this.client.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      client_reference_id: input.userId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      integration_identifier: "stockai_web_kqmdxjtr",
      metadata: { better_auth_user_id: input.userId },
      subscription_data: {
        billing_mode: { type: "flexible" },
        metadata: { better_auth_user_id: input.userId },
      },
    }, { idempotencyKey: input.idempotencyKey });
  }

  async createCreditCheckout(input: {
    customerId: string;
    credits: number;
    idempotencyKey: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    userId: string;
  }): Promise<{ url: string | null }> {
    return this.client.checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      client_reference_id: input.userId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      integration_identifier: "stockai_credit_kqmdxjtr",
      metadata: {
        better_auth_user_id: input.userId,
        purchase_type: "ai_credit_pack",
        credits: String(input.credits),
      },
    }, { idempotencyKey: input.idempotencyKey });
  }

  async createPortal(customerId: string, returnUrl: string): Promise<{ url: string }> {
    return this.client.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  }

  async verifyWebhook(payload: string, signature: string, webhookSecret: string): Promise<BillingWebhookEvent> {
    const event = await this.client.webhooks.constructEventAsync(payload, signature, webhookSecret);
    const object = event.data.object;
    const subscription = object.object === "subscription"
      ? subscriptionSnapshot(object as Stripe.Subscription)
      : null;
    const creditCheckout = object.object === "checkout.session"
      ? (() => {
        const session = object as Stripe.Checkout.Session;
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
        const credits = Number(session.metadata?.credits ?? "");
        return {
          id: session.id,
          customerId,
          mode: session.mode,
          paymentStatus: session.payment_status,
          userIdMetadata: session.metadata?.better_auth_user_id ?? null,
          purchaseType: session.metadata?.purchase_type ?? null,
          credits: Number.isInteger(credits) && credits > 0 ? credits : null,
        };
      })()
      : null;
    return { id: event.id, type: event.type, created: event.created, subscription, creditCheckout };
  }
}
