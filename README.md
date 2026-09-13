# CraftGuild — Payments & Settlement

An India-first creator publishing platform's money layer: closed-loop credits,
payment-aggregator split settlement, a double-entry ledger, and the statutory
tax engine (GST, TCS under CGST s.52, TDS under Income-tax s.194-O).

Implements the architecture in *Payment, Settlement & Fee Architecture for an
India-First Creator Publishing Platform* — platform-as-ECO with split
settlement through an RBI-authorised payment aggregator, so the platform never
takes custody of reader money and its GST aggregate turnover is its 10%
commission rather than GMV.

---

## The one design decision everything else follows from

**The platform never holds customer money.**

A reader's payment goes into the aggregator's escrow account. At settlement the
creator's share is transferred to the creator's *own* bank account or VPA, and
only the platform's commission reaches the platform's account.

Three consequences, all enforced in code:

| Consequence | Where it is enforced |
|---|---|
| The platform is not an unauthorised payment aggregator (PSS Act s.26) | No account models platform custody of gross funds; `PA_ESCROW_RECEIVABLE` is a claim on the aggregator's escrow, and money leaves it only to a creator's own account |
| The platform's GST turnover is commission, not GMV | `PLATFORM_FEE_REVENUE` is the only income account credited from a sale; `v_platform_gst_turnover` reports it, and a reconciliation control asserts commission ≤ 10% of GMV |
| Coins are a liability, not revenue | `CREDIT_LIABILITY` is credited at top-up with no GST event (CBIC Circular 243/37/2024); GST arises only at redemption |

---

## Architecture

Hexagonal. The domain layer imports no vendor SDK and performs no IO.

```
src/
  domain/          pure: money, ledger, tax, pricing, settlement cycle
  ports/           PaymentPort, SettlementPort, repository contracts
  adapters/        cashfree (real HTTP), postgres, redis, crypto
  app/             use cases: onboarding, credits, redemption, refunds,
                   settlement, payouts, webhooks, reporting, risk
  http/            Fastify server, routes, auth, error mapping
  jobs/            worker loops (webhooks, outbox, settlement, payouts)
migrations/        forward-only SQL, checksum-verified
tools/cashfree-sim Cashfree HTTP-contract server used only by tests
```

### Money

Every monetary value is an **integer number of paise**. No floating point value
ever represents money.

- Rates are parts-per-million integers; `applyRateHalfUp` multiplies in integer
  space and rounds half away from zero, the convention Indian tax computation
  and PSP invoices use.
- `allocateByWeight` splits a total by the largest-remainder method, so parts
  always sum back to the total exactly.
- Postgres `BIGINT` **and** `NUMERIC` are both parsed to validated safe
  integers. This matters: `SUM()` over a `bigint` returns `numeric`, which
  arrives as a string, and a string silently concatenates instead of adding.

### Double-entry ledger

Append-only, self-balancing, enforced in two independent places:

1. `buildEntry()` refuses to construct an unbalanced entry, a posting with a
   non-positive amount, or a creator-scoped account without a creator id.
2. Postgres enforces it again with a **deferred constraint trigger**, plus
   triggers that reject any `UPDATE` or `DELETE` on ledger rows.

Corrections are made by posting reversing entries, never by mutation.

Chart of accounts is in `src/domain/ledger/accounts.ts`, one account per line of
the blueprint's Part 13, with the addition of `PROMOTIONAL_CREDIT_EXPENSE` —
bonus coins in a bundle are redeemable at full face value, so they are a real
liability funded by marketing spend, not a discount on the creator's share.

### The statutory tax engine

Rates are **dated and cited**, so a change in law is a data change:

| Levy | Rate | Basis |
|---|---|---|
| GST on platform commission | 18% | The commission is the platform's own outward supply |
| TCS (CGST s.52) | 0.5% | Notification 15/2024-CT (10 Jul 2024). Collected **only** from GST-registered creators — an unregistered creator has no electronic cash ledger to credit |
| TDS (s.194-O) | 0.1% | Finance (No. 2) Act 2024, effective 1 Oct 2024 |
| TDS without PAN | 5% | s.206AA |

TDS is computed **cumulatively over the financial year**. The ₹5 lakh exemption
is conditional on the creator being an individual or HUF *and* staying under the
ceiling; crossing it loses the exemption for the whole year, so the crossing
period carries a catch-up deduction. Historic rates remain in the book, so a
back-dated computation produces the rate that was in force.

PAN and GSTIN are validated with real algorithms — PAN's 4th character decodes
holder status (which drives the 194-O exemption), and GSTIN's modulus-36 check
digit is verified, not just its shape.

### Exactly-once under at-least-once delivery

| Mechanism | Guards against |
|---|---|
| `Idempotency-Key` on every mutating endpoint, stored with a request fingerprint | A retried client request creating two orders; a reused key with a different body is refused |
| Webhook deduplication on `(provider, provider_event_id)` | Duplicate aggregator deliveries granting coins twice |
| Derived ledger idempotency keys (`sha256(intent + ids)`) | A replayed business event double-posting |
| Transactional outbox | An aggregator timeout rolling back a committed ledger posting, or a commit losing its external effect |
| `pg_advisory_xact_lock` on wallet / creator / period / payout | Concurrent unlocks overdrawing a wallet or double-charging a chapter |
| `FOR UPDATE SKIP LOCKED` claims | Multiple worker replicas processing one message |

A payment webhook never grants value on the webhook's word: the payment is
re-read from the aggregator and the amount checked against the order first.

### Money-at-risk controls

- **Reserve holdback** (10% by default) retained through the 5-day grace window,
  which funds chargebacks that land after the creator's share settled out.
- **Delayed first payout** and **velocity caps** against self-purchase laundering.
- **Bounced payouts reinstate the payable** — a failed bank transfer never
  leaves the creator's money existing nowhere.
- **Eight reconciliation controls** (`GET /v1/admin/reports/reconcile`) assert
  the ledger against its sub-ledgers, wallets and redemptions.

---

## Settlement cycle

```
Day 1..30   accrual    redemptions land in the open period
Day 31..35  grace      refunds, disputes and reversals still attach
Day 36      finalise   reserve released -> TCS and TDS computed over the
                       period -> statement issued -> payout dispatched
```

A balance below the minimum payout threshold **carries forward** — the money
stays in `CREATOR_PAYABLE`, which is the creator's, and is simply not yet
dispatched.

Creator statement line order follows the blueprint exactly:

```
Gross → PG fee → GST on PG fee → Platform fee (10%) → GST on platform fee
      → TCS (0.5%, if registered) → TDS (0.1%, if above ₹5 lakh) → Creator net
```

On a ₹500 chapter that is ₹427.72 net to the creator. (Part 9 of the blueprint
quotes "approximately ₹440"; that figure nets only the headline fees, while the
statement ordering the same document mandates also puts the GST on those fees on
the creator, as Part 5 says happens for an unregistered creator who cannot claim
input credit. The code follows the statement ordering.)

---

## Running it

Requires Node 22+, PostgreSQL 16+, Redis 7+.

```bash
npm install
cp .env.example .env          # fill in real values
npm run migrate
npm start                     # API
npm run start:worker          # background loops
```

### Tests

```bash
npm run test:unit             # 47 tests: money, tax, ledger, split, fee parity
npm run test:e2e              # 34 tests: full lifecycle + settlement
npm run stress                # end-to-end stress test under fault injection
```

The end-to-end suite boots the **real** application — real Fastify server, real
Postgres, real Redis, the real Cashfree adapter — and points that adapter at
`tools/cashfree-sim`, a local server implementing Cashfree's HTTP contract: the
same paths, auth headers, decimal-rupee wire format and base64-HMAC webhook
signing. Nothing inside `src/` is substituted or stubbed. Set
`CASHFREE_BASE_URL` to a real Cashfree environment and the same adapter talks to
Cashfree.

The stress test injects what a real aggregator does — transient 503s, duplicated
webhook deliveries, bounced bank transfers, latency — and asserts that no paisa
is lost, duplicated or stranded.

```bash
npm run stress -- --readers 400 --creators 50 --duration 60 --concurrency 64
```

---

## The public site

`web/` is a Next.js app, statically prerendered, that states the platform's one
distinguishing claim: the fee is 10% and every other rupee is accounted for by
name. Its hero is a live calculator where a creator enters their own chapter
price and watches the money land in four named destinations — themselves,
CraftGuild, the payment network, and GST to the government.

Those figures are not marketing approximations. `web/lib/fees.ts` carries the
schedule, and `test/unit/fee-parity.test.ts` asserts it against
`DEFAULT_FEE_SCHEDULE`, comparing both split implementations across 3,000
amounts paise for paise. **A rate that drifts on the public site fails the build
rather than reaching a creator.**

```bash
cd web && npm ci && npm run dev
```

### Deploying it

The site deploys to Vercel from this repository. It lives in a subdirectory, so
the project's **Root Directory must be set to `web`** — everything else is
auto-detected.

1. Vercel → Add New → Project → import this repository
2. Set Root Directory to `web`
3. Deploy

After that, every push to `main` redeploys automatically. No environment
variables are required: the page is fully static and reads no secrets.

---

## Deployed infrastructure

| Piece | Where | Notes |
|---|---|---|
| Database | Supabase, `ap-south-1` (Mumbai) | Chosen for latency and data residency for Indian readers and creators |
| Schema | 4 migrations applied | 25 tables, 6 views, append-only ledger triggers, RLS deny-all |
| API + worker | Not yet hosted | See the note below |

The Fastify API and the worker are long-running processes and still need a
container host. The worker's every action is also exposed as an admin endpoint
(`/v1/admin/settlements/close`, `/payouts/dispatch`, `/webhooks/process`,
`/outbox/drain`), so a scheduler hitting those over HTTP can drive the whole
background layer without a persistent worker process.

Redis is still required for rate limiting, distributed locks and the
idempotency cache; Supabase does not provide it.

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/register`, `/v1/auth/login` | Identity |
| POST | `/v1/creators/onboard` | KYC + aggregator vendor registration |
| PUT | `/v1/creators/me/gstin` | Add a GSTIN as the creator nears their threshold |
| POST | `/v1/works`, `/v1/works/:id/chapters`, `/v1/chapters/:id/publish` | Catalogue |
| GET | `/v1/credits/bundles` | Coin bundles |
| POST | `/v1/credits/orders` | Buy coins (idempotent) |
| POST | `/v1/tips` | Tip a creator, split at capture (idempotent) |
| POST | `/v1/chapters/:id/unlock` | Spend coins; the taxable supply |
| POST | `/v1/redemptions/:id/refund` | Refund to coins or to source |
| GET | `/v1/creators/me/statements`, `/v1/creators/me/balance` | Earnings |
| POST | `/v1/webhooks/cashfree` | Signed aggregator callbacks |
| POST | `/v1/admin/settlements/close` | Finalise due periods |
| GET | `/v1/admin/reports/gstr8/:periodId` | GSTR-8 (TCS), due the 10th |
| GET | `/v1/admin/reports/26q/:periodId` | Form 26Q (TDS) |
| GET | `/v1/admin/reports/reconcile` | Financial integrity controls |
| GET | `/healthz`, `/readyz`, `/metrics` | Operations |

---

## Compliance calendar the system supports

| Cadence | Obligation | Endpoint |
|---|---|---|
| Monthly, by the 10th | GSTR-8 (TCS) | `/v1/admin/reports/gstr8/:periodId` |
| Monthly, by the 7th | TDS deposit (194-O) | `/v1/admin/reports/26q/:periodId` |
| Monthly | GSTR-1 / GSTR-3B on own commission | `/v1/admin/reports/gst-turnover` |
| Monthly | Settlement close with 5-day grace | `/v1/admin/settlements/close` |
| Quarterly | Form 26Q, Form 16A | `/v1/admin/reports/26q/:periodId` |

---

## What still needs a human

This is engineering, not legal advice. Before going live, the blueprint's Part
15 list stands, in particular:

- **CA sign-off** that the split-settlement structure limits the platform's
  aggregate turnover to commission, and on the pure-agent (Rule 33) position.
- **Fintech counsel** on whether closed-loop coins make the platform a PPI
  issuer — the **Draft PPI Directions 2026** propose removing the closed-system
  exemption for marketplaces, which is the single largest open regulatory risk
  to the credits model. `PLATFORM_FEE_PERCENT` and the bundle table are
  configuration precisely so the platform can switch to per-transaction charging
  without a rewrite if that carve-out is finalised.
- Whether inter-state supply of services forces creator GST registration from
  the first rupee.

Provider rates (`PG_FEE_PERCENT`, `SPLIT_FEE_PERCENT`) default to the
conservative standard rates, not festive-offer rates. Replace them with your
negotiated merchant agreement.
