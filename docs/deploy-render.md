# Deploying the payments backend on Render

The public site (Next.js, `web/`) goes to Vercel. The API, the background loops
and Redis go to Render. Postgres is Supabase, in Mumbai.

## Why the backend is not split across providers

Render's Key Value instances have no public endpoint — the `ipAllowList` is
empty and cannot be opened to the internet. Anything that needs Redis has to sit
on Render's private network, in the **same region**, which is why the API,
Redis and the keep-alive cron are all in `singapore` (Render's closest region to
India; there is no Mumbai region). The same constraint rules out AWS
ElastiCache, which is VPC-only: choosing it would drag the entire backend into
AWS rather than just the cache.

## Live resources

| Resource | Kind | Region | Plan | ID |
| --- | --- | --- | --- | --- |
| `craftguild-redis` | Render Key Value | singapore | free | `red-daj33afqj5pc73c2poq0` |
| `craftguild-api` | Render Web Service | singapore | free | `srv-daj349fqj5pc73c2su00` |
| `craftguild-production` | Supabase Postgres | ap-south-1 | free | `zqztamvjaunsolxmzofh` |

API URL: <https://craftguild-api.onrender.com>

## Why the free Key Value tier is safe here

Redis holds exactly two things, and neither is a system of record:

- **Rate-limit buckets** (`RateLimiter`). The limiter fails open on an outage by
  design — availability of the platform beats the precision of a soft throttle.
- **Job locks** (`DistributedLock`). Coarse "one replica runs the settlement
  close" guards, TTL'd and re-acquirable. The actual exclusion that protects the
  money is `pg_advisory_xact_lock` and `FOR UPDATE SKIP LOCKED` inside Postgres,
  so a lost Redis lock costs a duplicate attempt that the ledger's idempotency
  keys reject — not a double payout.

Idempotency keys, the outbox and every ledger row live in Postgres. Nothing in
Redis needs to survive a restart, so `persistenceMode: off` is correct rather
than merely cheap.

`maxmemoryPolicy` is `volatile_ttl`: every key this service writes carries a
TTL, and under memory pressure it evicts the ones closest to expiring — the
short-lived rate-limit buckets — in preference to a ten-minute job lock.

## One container, both roles

`RUN_WORKER_IN_PROCESS=true` starts the background loops inside the API process
instead of a separate worker service. Every loop already claims its work with
`SKIP LOCKED` or an advisory lock, so co-locating them changes *which process*
runs a loop, never *how* the work is claimed. Split them back out — `npm run
start:worker` — the moment the API's request load and the loops start competing
for the same CPU.

A free web service sleeps after 15 minutes without traffic, and a sleeping
service closes no settlement periods. Render's own Cron Jobs are paid-only
(no free plan), so a keep-alive there costs the same as simply not sleeping.
Two honest options:

- **Free:** point an external uptime pinger (UptimeRobot's free tier does 5-minute
  checks) at `https://craftguild-api.onrender.com/healthz`. The instance stays
  awake and the loops keep running.
- **$7/month:** move `craftguild-api` to the Starter plan, which never sleeps.
  This is the right answer the day real readers are paying, because a free
  instance also cold-starts for ~50 seconds — survivable for a Cashfree webhook,
  which retries, and poor for a reader tapping "unlock".

Until one of those is in place, the settlement close and payout loops only run
while something is keeping the service awake. Nothing is lost when it sleeps —
work is claimed from Postgres on wake, and webhook deliveries queue in the
`webhook_events` table — but a period closes late.

## Environment variables that still need values

Everything else is already set. These six cannot be set from here, because they
are either your merchant credentials or a secret nobody should have copied
through a chat transcript:

| Variable | Where it comes from |
| --- | --- |
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string (URI), **Session pooler**, with your DB password. Append `?sslmode=require`. |
| `REDIS_URL` | Render → `craftguild-redis` → **Internal** Key Value URL (`redis://red-…:6379`). The external URL will not work. |
| `JWT_SECRET` | Generate: `openssl rand -base64 48`. Production boot refuses anything under 48 characters. |
| `CASHFREE_APP_ID` | Cashfree merchant dashboard → Developers → API Keys. |
| `CASHFREE_SECRET_KEY` | Same page. |
| `CASHFREE_WEBHOOK_SECRET` | Cashfree → Developers → Webhooks, after registering `https://craftguild-api.onrender.com/v1/webhooks/cashfree`. |

`NODE_ENV=production` is set, and boot **refuses to start against a sandbox
Cashfree URL in production** — a deliberate guard against shipping test
credentials. To exercise the deployment against Cashfree's sandbox first, set
`NODE_ENV=development` and `CASHFREE_BASE_URL=https://sandbox.cashfree.com`
together, then flip both when the merchant account goes live.

`RUN_MIGRATIONS_ON_BOOT=true` means the first successful boot applies all five
migrations. They are already applied on the Supabase project, and the migrator
is idempotent under an advisory lock, so this is safe on every deploy.

## Before real money moves

Nothing in this deployment addresses Part 15 of the blueprint. The closed-loop
coin model in particular needs a fintech lawyer's read on the **Draft PPI
Directions 2026** marketplace carve-out, and the ECO/TCS/TDS positions need a CA
to sign off, before the platform accepts a rupee from a real reader.
