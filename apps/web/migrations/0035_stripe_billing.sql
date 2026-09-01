-- 0035_stripe_billing.sql — local Stripe Billing read model.
-- Stripe remains the billing authority. D1 stores only the minimum mapping and
-- subscription state required by authenticated product routes.

CREATE TABLE stripe_customers (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE TABLE stripe_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_price_id TEXT,
  status TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  current_period_end TEXT,
  latest_event_created_at INTEGER NOT NULL,
  latest_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (stripe_customer_id) REFERENCES stripe_customers(stripe_customer_id) ON DELETE CASCADE
);

CREATE INDEX stripe_subscriptions_user_status_idx
ON stripe_subscriptions(user_id, status, updated_at DESC);

CREATE TABLE stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_created_at INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE stripe_credit_purchases (
  checkout_session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  stripe_event_id TEXT NOT NULL UNIQUE,
  paid_at TEXT NOT NULL,
  credited INTEGER NOT NULL DEFAULT 0 CHECK (credited IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX stripe_credit_purchases_user_idx
ON stripe_credit_purchases(user_id, created_at DESC);
