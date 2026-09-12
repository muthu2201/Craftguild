-- CraftGuild payments & settlement core schema.
-- All monetary columns are BIGINT paise. There are no floating point amounts
-- anywhere in this database by design.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  email_normalised  TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  phone             TEXT,
  role              TEXT NOT NULL CHECK (role IN ('reader','creator','admin')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE creators (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  legal_name             TEXT NOT NULL,
  pen_name               TEXT NOT NULL,
  pan                    TEXT,
  pan_verified           BOOLEAN NOT NULL DEFAULT FALSE,
  gstin                  TEXT,
  gstin_verified_at      TIMESTAMPTZ,
  entity_type            TEXT NOT NULL DEFAULT 'individual',
  state_code             TEXT,
  bank_account_number    TEXT,
  bank_ifsc              TEXT,
  bank_account_holder    TEXT,
  upi_vpa                TEXT,
  vendor_ref             TEXT UNIQUE,
  provider_vendor_id     TEXT,
  kyc_status             TEXT NOT NULL DEFAULT 'draft'
                           CHECK (kyc_status IN ('draft','submitted','pending','in_review','active','blocked','rejected')),
  kyc_failure_reason     TEXT,
  payouts_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  first_payout_hold_until TIMESTAMPTZ,
  lifetime_gross_paise   BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_gross_paise >= 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT creators_pan_format CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  CONSTRAINT creators_gstin_format CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  CONSTRAINT creators_payout_instrument CHECK (
    kyc_status <> 'active'
    OR upi_vpa IS NOT NULL
    OR (bank_account_number IS NOT NULL AND bank_ifsc IS NOT NULL)
  )
);

CREATE UNIQUE INDEX creators_pan_uniq ON creators(pan) WHERE pan IS NOT NULL;
CREATE UNIQUE INDEX creators_gstin_uniq ON creators(gstin) WHERE gstin IS NOT NULL;
CREATE INDEX creators_kyc_status_idx ON creators(kyc_status);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE works (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  title       TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  synopsis    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX works_creator_idx ON works(creator_id);

CREATE TABLE chapters (
  id             TEXT PRIMARY KEY,
  work_id        TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  creator_id     TEXT NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  sequence       INTEGER NOT NULL CHECK (sequence > 0),
  title          TEXT NOT NULL,
  body_uri       TEXT NOT NULL DEFAULT '',
  price_credits  INTEGER NOT NULL CHECK (price_credits >= 0),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished')),
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_id, sequence)
);
CREATE INDEX chapters_creator_idx ON chapters(creator_id);
CREATE INDEX chapters_status_idx ON chapters(status) WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- Closed-loop credits (coins)
-- ---------------------------------------------------------------------------

CREATE TABLE credit_wallets (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance_credits  BIGINT NOT NULL DEFAULT 0 CHECK (balance_credits >= 0),
  lifetime_purchased BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_purchased >= 0),
  lifetime_spent   BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
  version          BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Individual credit lots, so expiry (breakage) is FIFO and auditable.
CREATE TABLE credit_lots (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_id          TEXT NOT NULL,
  credits_granted   BIGINT NOT NULL CHECK (credits_granted > 0),
  credits_remaining BIGINT NOT NULL CHECK (credits_remaining >= 0),
  paise_per_credit  BIGINT NOT NULL CHECK (paise_per_credit > 0),
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  expired           BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT credit_lots_remaining_le_granted CHECK (credits_remaining <= credits_granted)
);
CREATE INDEX credit_lots_user_fifo_idx ON credit_lots(user_id, granted_at) WHERE credits_remaining > 0;
CREATE INDEX credit_lots_expiry_idx ON credit_lots(expires_at) WHERE credits_remaining > 0 AND expired = FALSE;

CREATE TABLE credit_movements (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  lot_id       TEXT REFERENCES credit_lots(id),
  delta        BIGINT NOT NULL CHECK (delta <> 0),
  reason       TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX credit_movements_user_idx ON credit_movements(user_id, created_at DESC);
CREATE UNIQUE INDEX credit_movements_ref_uniq ON credit_movements(reason, reference_id, user_id);

-- ---------------------------------------------------------------------------
-- Orders and payments (money never touches a platform account; these records
-- track the payment aggregator's escrow position on our behalf)
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind                TEXT NOT NULL CHECK (kind IN ('credit_topup','tip')),
  sku                 TEXT,
  amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
  credits             BIGINT NOT NULL DEFAULT 0 CHECK (credits >= 0),
  target_creator_id   TEXT REFERENCES creators(id),
  status              TEXT NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','pending','paid','failed','expired','cancelled')),
  provider_order_id   TEXT UNIQUE,
  payment_session_id  TEXT,
  idempotency_key     TEXT NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at             TIMESTAMPTZ,
  CONSTRAINT orders_tip_has_creator CHECK (kind <> 'tip' OR target_creator_id IS NOT NULL),
  CONSTRAINT orders_topup_has_credits CHECK (kind <> 'credit_topup' OR credits > 0)
);
CREATE INDEX orders_user_idx ON orders(user_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders(status) WHERE status IN ('created','pending');

CREATE TABLE payments (
  id                   TEXT PRIMARY KEY,
  order_id             TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider_payment_id  TEXT NOT NULL UNIQUE,
  status               TEXT NOT NULL,
  amount_paise         BIGINT NOT NULL CHECK (amount_paise > 0),
  method               TEXT NOT NULL DEFAULT 'unknown',
  pg_fee_paise         BIGINT NOT NULL DEFAULT 0 CHECK (pg_fee_paise >= 0),
  gst_on_pg_fee_paise  BIGINT NOT NULL DEFAULT 0 CHECK (gst_on_pg_fee_paise >= 0),
  bank_reference       TEXT,
  refunded_paise       BIGINT NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  chargeback_paise     BIGINT NOT NULL DEFAULT 0 CHECK (chargeback_paise >= 0),
  failure_reason       TEXT,
  captured_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_refund_within_amount CHECK (refunded_paise + chargeback_paise <= amount_paise)
);
CREATE INDEX payments_order_idx ON payments(order_id);

-- ---------------------------------------------------------------------------
-- Settlement periods
-- ---------------------------------------------------------------------------

CREATE TABLE settlement_periods (
  id            TEXT PRIMARY KEY,
  sequence      INTEGER NOT NULL UNIQUE,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  grace_end     TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','grace','finalising','finalised')),
  finalised_at  TIMESTAMPTZ,
  CONSTRAINT settlement_periods_ordering CHECK (period_start < period_end AND period_end <= grace_end)
);
CREATE UNIQUE INDEX settlement_periods_single_open ON settlement_periods((status = 'open')) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Redemptions (the taxable supply) and entitlements
-- ---------------------------------------------------------------------------

CREATE TABLE redemptions (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  chapter_id                TEXT REFERENCES chapters(id),
  creator_id                TEXT NOT NULL REFERENCES creators(id) ON DELETE RESTRICT,
  period_id                 TEXT NOT NULL REFERENCES settlement_periods(id),
  kind                      TEXT NOT NULL CHECK (kind IN ('chapter','tip')),
  gross_paise               BIGINT NOT NULL CHECK (gross_paise > 0),
  pg_fee_paise              BIGINT NOT NULL CHECK (pg_fee_paise >= 0),
  gst_on_pg_fee_paise       BIGINT NOT NULL CHECK (gst_on_pg_fee_paise >= 0),
  platform_fee_paise        BIGINT NOT NULL CHECK (platform_fee_paise >= 0),
  gst_on_platform_fee_paise BIGINT NOT NULL CHECK (gst_on_platform_fee_paise >= 0),
  split_fee_paise           BIGINT NOT NULL CHECK (split_fee_paise >= 0),
  gst_on_split_fee_paise    BIGINT NOT NULL CHECK (gst_on_split_fee_paise >= 0),
  creator_gross_paise       BIGINT NOT NULL CHECK (creator_gross_paise >= 0),
  reserve_held_paise        BIGINT NOT NULL DEFAULT 0 CHECK (reserve_held_paise >= 0),
  reserve_released_paise    BIGINT NOT NULL DEFAULT 0 CHECK (reserve_released_paise >= 0),
  refunded_paise            BIGINT NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  status                    TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','refunded','partially_refunded','charged_back')),
  funding_order_id          TEXT REFERENCES orders(id),
  idempotency_key           TEXT NOT NULL UNIQUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT redemptions_split_reconstitutes CHECK (
    gross_paise = pg_fee_paise + gst_on_pg_fee_paise + platform_fee_paise
                + gst_on_platform_fee_paise + split_fee_paise + gst_on_split_fee_paise
                + creator_gross_paise
  ),
  CONSTRAINT redemptions_reserve_within_creator_gross CHECK (reserve_held_paise <= creator_gross_paise),
  CONSTRAINT redemptions_reserve_release_bounded CHECK (reserve_released_paise <= reserve_held_paise),
  CONSTRAINT redemptions_refund_bounded CHECK (refunded_paise <= gross_paise),
  CONSTRAINT redemptions_chapter_presence CHECK ((kind = 'chapter') = (chapter_id IS NOT NULL))
);
CREATE INDEX redemptions_creator_period_idx ON redemptions(creator_id, period_id);
CREATE INDEX redemptions_period_idx ON redemptions(period_id);
CREATE INDEX redemptions_user_idx ON redemptions(user_id, created_at DESC);

CREATE TABLE entitlements (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  chapter_id    TEXT NOT NULL REFERENCES chapters(id) ON DELETE RESTRICT,
  redemption_id TEXT NOT NULL REFERENCES redemptions(id),
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, chapter_id)
);
CREATE INDEX entitlements_chapter_idx ON entitlements(chapter_id);

-- ---------------------------------------------------------------------------
-- Double-entry ledger. Append-only; balance enforced by a deferred constraint.
-- ---------------------------------------------------------------------------

CREATE TABLE journal_entries (
  id              TEXT PRIMARY KEY,
  entry_type      TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reference_type  TEXT NOT NULL,
  reference_id    TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  total_paise     BIGINT NOT NULL CHECK (total_paise > 0),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX journal_entries_reference_idx ON journal_entries(reference_type, reference_id);
CREATE INDEX journal_entries_occurred_idx ON journal_entries(occurred_at);
CREATE INDEX journal_entries_type_idx ON journal_entries(entry_type, occurred_at);

CREATE TABLE journal_lines (
  id           BIGSERIAL PRIMARY KEY,
  entry_id     TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  creator_id   TEXT REFERENCES creators(id),
  memo         TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX journal_lines_entry_idx ON journal_lines(entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_code, occurred_at);
CREATE INDEX journal_lines_creator_idx ON journal_lines(creator_id, account_code) WHERE creator_id IS NOT NULL;

-- Append-only: the ledger is never mutated, only extended with reversing entries.
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are append-only (attempted % on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Every entry must balance. Deferred to commit so lines can be inserted in any
-- order within the transaction.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  debit_total  BIGINT;
  credit_total BIGINT;
  declared     BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0),
         COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)
    INTO debit_total, credit_total
    FROM journal_lines WHERE entry_id = NEW.entry_id;

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'journal entry % does not balance: debits=% credits=%',
      NEW.entry_id, debit_total, credit_total USING ERRCODE = 'check_violation';
  END IF;

  SELECT total_paise INTO declared FROM journal_entries WHERE id = NEW.entry_id;
  IF declared IS NULL THEN
    RAISE EXCEPTION 'journal entry % has no header', NEW.entry_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF declared <> debit_total THEN
    RAISE EXCEPTION 'journal entry % header total % does not match posted debits %',
      NEW.entry_id, declared, debit_total USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- ---------------------------------------------------------------------------
-- Refunds, chargebacks
-- ---------------------------------------------------------------------------

CREATE TABLE refunds (
  id                  TEXT PRIMARY KEY,
  redemption_id       TEXT REFERENCES redemptions(id),
  order_id            TEXT REFERENCES orders(id),
  payment_id          TEXT REFERENCES payments(id),
  creator_id          TEXT REFERENCES creators(id),
  mode                TEXT NOT NULL CHECK (mode IN ('to_credits','to_source')),
  amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','succeeded','failed','cancelled')),
  provider_refund_id  TEXT,
  idempotency_key     TEXT NOT NULL UNIQUE,
  requested_by        TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at          TIMESTAMPTZ,
  CONSTRAINT refunds_target CHECK (redemption_id IS NOT NULL OR order_id IS NOT NULL)
);
CREATE INDEX refunds_redemption_idx ON refunds(redemption_id);
CREATE INDEX refunds_status_idx ON refunds(status) WHERE status IN ('pending','processing');

CREATE TABLE chargebacks (
  id                 TEXT PRIMARY KEY,
  payment_id         TEXT NOT NULL REFERENCES payments(id),
  order_id           TEXT NOT NULL REFERENCES orders(id),
  amount_paise       BIGINT NOT NULL CHECK (amount_paise > 0),
  provider_dispute_id TEXT NOT NULL UNIQUE,
  reason             TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','contested','won','lost')),
  recovered_from_reserve_paise BIGINT NOT NULL DEFAULT 0 CHECK (recovered_from_reserve_paise >= 0),
  absorbed_paise     BIGINT NOT NULL DEFAULT 0 CHECK (absorbed_paise >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Statements, withholding ledgers, payouts
-- ---------------------------------------------------------------------------

CREATE TABLE creator_statements (
  id                          TEXT PRIMARY KEY,
  period_id                   TEXT NOT NULL REFERENCES settlement_periods(id),
  creator_id                  TEXT NOT NULL REFERENCES creators(id),
  gross_paise                 BIGINT NOT NULL DEFAULT 0,
  pg_fee_paise                BIGINT NOT NULL DEFAULT 0,
  gst_on_pg_fee_paise         BIGINT NOT NULL DEFAULT 0,
  platform_fee_paise          BIGINT NOT NULL DEFAULT 0,
  gst_on_platform_fee_paise   BIGINT NOT NULL DEFAULT 0,
  split_fee_paise             BIGINT NOT NULL DEFAULT 0,
  gst_on_split_fee_paise      BIGINT NOT NULL DEFAULT 0,
  creator_gross_paise         BIGINT NOT NULL DEFAULT 0,
  tcs_paise                   BIGINT NOT NULL DEFAULT 0 CHECK (tcs_paise >= 0),
  tds_paise                   BIGINT NOT NULL DEFAULT 0 CHECK (tds_paise >= 0),
  tcs_rate_ppm                BIGINT NOT NULL DEFAULT 0,
  tds_rate_ppm                BIGINT NOT NULL DEFAULT 0,
  reserve_released_paise      BIGINT NOT NULL DEFAULT 0,
  refund_adjustment_paise     BIGINT NOT NULL DEFAULT 0,
  chargeback_adjustment_paise BIGINT NOT NULL DEFAULT 0,
  opening_carry_forward_paise BIGINT NOT NULL DEFAULT 0,
  net_payable_paise           BIGINT NOT NULL DEFAULT 0,
  carried_forward_paise       BIGINT NOT NULL DEFAULT 0 CHECK (carried_forward_paise >= 0),
  transaction_count           INTEGER NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','issued','paid','carried_forward')),
  issued_at                   TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_id, creator_id)
);
CREATE INDEX creator_statements_creator_idx ON creator_statements(creator_id, created_at DESC);
CREATE INDEX creator_statements_status_idx ON creator_statements(status);

-- Cumulative financial-year withholding position, the basis for s.194-O.
CREATE TABLE creator_fy_tax (
  creator_id        TEXT NOT NULL REFERENCES creators(id),
  financial_year    TEXT NOT NULL,
  gross_paise       BIGINT NOT NULL DEFAULT 0 CHECK (gross_paise >= 0),
  tds_deducted_paise BIGINT NOT NULL DEFAULT 0 CHECK (tds_deducted_paise >= 0),
  tcs_collected_paise BIGINT NOT NULL DEFAULT 0 CHECK (tcs_collected_paise >= 0),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_id, financial_year)
);

CREATE TABLE payouts (
  id                   TEXT PRIMARY KEY,
  creator_id           TEXT NOT NULL REFERENCES creators(id),
  statement_id         TEXT NOT NULL REFERENCES creator_statements(id),
  amount_paise         BIGINT NOT NULL CHECK (amount_paise > 0),
  fee_paise            BIGINT NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','instructed','processing','succeeded','failed','reversed')),
  provider_transfer_id TEXT,
  utr                  TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  failure_reason       TEXT,
  idempotency_key      TEXT NOT NULL UNIQUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at           TIMESTAMPTZ,
  UNIQUE (statement_id)
);
CREATE INDEX payouts_status_idx ON payouts(status) WHERE status IN ('queued','instructed','processing');
CREATE INDEX payouts_creator_idx ON payouts(creator_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Infrastructure: idempotency, webhooks, outbox, audit
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  scope           TEXT NOT NULL,
  key             TEXT NOT NULL,
  user_id         TEXT,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight','completed','failed')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);

CREATE TABLE webhook_events (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  payload        JSONB NOT NULL,
  raw_body       TEXT NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','processing','processed','failed','ignored')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  processed_at   TIMESTAMPTZ,
  available_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX webhook_events_pending_idx ON webhook_events(status, available_at) WHERE status IN ('pending','failed');

CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by     TEXT,
  locked_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX outbox_ready_idx ON outbox(status, available_at) WHERE status IN ('pending','processing');

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    TEXT,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_subject_idx ON audit_log(subject_type, subject_id, created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_id, created_at DESC);

-- Provider fee invoices, reconciled against our own expectation.
CREATE TABLE provider_settlements (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  provider_settlement_id TEXT NOT NULL,
  amount_paise        BIGINT NOT NULL,
  fee_paise           BIGINT NOT NULL DEFAULT 0,
  utr                 TEXT,
  settled_at          TIMESTAMPTZ,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  reconciled          BOOLEAN NOT NULL DEFAULT FALSE,
  variance_paise      BIGINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_settlement_id)
);

-- Risk controls: velocity and self-purchase detection.
CREATE TABLE risk_signals (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  creator_id  TEXT REFERENCES creators(id),
  signal      TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('info','warn','block')),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_signals_user_idx ON risk_signals(user_id, created_at DESC);
CREATE INDEX risk_signals_creator_idx ON risk_signals(creator_id, created_at DESC);
