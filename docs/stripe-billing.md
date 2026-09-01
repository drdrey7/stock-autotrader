# Stripe Payments and Billing

The approved integration is a self-serve SaaS subscription flow:

```text
Investor Hub -> Worker billing API -> Stripe-hosted Checkout
Stripe webhook -> signature verification -> D1 billing read model -> Investor Hub
Investor Hub -> Worker billing API -> Stripe Customer Portal
```

Stripe is the billing authority. D1 stores only the Better Auth user-to-Customer
mapping, the latest subscription snapshot, and processed webhook event IDs. The
browser never receives a Stripe secret or calls Stripe's API directly.

## Product catalog

Create a separate Stripe Product for each customer-visible plan. Attach monthly
and annual recurring Prices to the same Product only when they are billing
interval variants of that plan. This initial integration expects one paid plan:

- `STRIPE_PRICE_MONTHLY`: its monthly recurring Price ID;
- `STRIPE_PRICE_ANNUAL`: its annual recurring Price ID.

AI Analysis credits are sold through one-time Prices. Configure a **credit-pack
catalog**: a JSON array, one entry per pack, each pairing the Price ID with the
exact number of credits it grants. Order the array cheapest-first — the UI
renders one "Buy N credits" button per pack.

- `STRIPE_CREDIT_PACKS`: JSON array of `{ "credits": number, "priceId": Price ID }`
  e.g. `[{"credits":5,"priceId":"price_abc"},{"credits":10,"priceId":"price_def"}]`.

The credit buttons stay hidden until at least one valid pack is configured. A paid
`checkout.session.completed` webhook is verified and recorded in the
`stripe_credit_purchases` ledger before credits are added to the user. The
ledger makes webhook retries exactly-once and rejects unpaid, mismatched, or
unknown-customer sessions.

Plan name, amounts, currency, trial policy, and paid-feature entitlements remain
product decisions. The code deliberately does not invent them.

## Cloudflare configuration

Use a restricted test-mode API key with only the Customer, Checkout Session,
Billing Portal, and subscription read permissions needed by this Worker. Never
commit it or paste it into client-side variables.

```bash
cd apps/web
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PRICE_MONTHLY
npx wrangler secret put STRIPE_PRICE_ANNUAL
npx wrangler secret put STRIPE_CREDIT_PACKS
```

For local development, place the same names in an ignored `apps/web/.dev.vars`
file. Use test-mode values only. The production and preview Workers must use
separate keys, webhook endpoints, Customers, Products, and Prices.

Configure a Stripe webhook endpoint at:

```text
https://<worker-host>/api/billing/webhook
```

Subscribe to:

- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `checkout.session.completed`

Apply migration `0035_stripe_billing.sql` before deploying the Worker. Configure
the Customer Portal in the Stripe Dashboard and enable Smart Retries plus failed
payment emails under Billing revenue recovery.

## Tax and go-live boundary

Automatic tax is intentionally disabled. Before enabling it, determine where the
business is registered to collect sales tax, VAT, or GST and add those active
registrations in Stripe Tax. Enabling calculation without registrations does not
collect tax. Until then, use Stripe Tax threshold monitoring.

Before switching from test mode, verify webhook replay behavior, Checkout success
and cancellation, Portal changes, payment failure recovery, cancel-at-period-end,
key restrictions, CSP, and the Stripe go-live checklist.
