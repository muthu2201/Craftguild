import { request, Agent } from 'undici';
import { randomUUID } from 'node:crypto';
import { err } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';

/**
 * HTTP transport for the payment aggregator.
 *
 * Production concerns handled here and nowhere else:
 *  - per-request timeout and a bounded connection pool
 *  - retry with full-jitter exponential backoff, only on idempotent-safe cases
 *  - an idempotency key on every mutating call
 *  - a circuit breaker so a PA outage degrades instead of exhausting the pool
 */

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly defaultHeaders: Record<string, string>;
  readonly logger: Logger;
  readonly circuitBreaker?: { readonly failureThreshold: number; readonly resetAfterMs: number };
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly requestId: string;
  readonly latencyMs: number;
}

type BreakerState = 'closed' | 'open' | 'half_open';

/** HTTP statuses worth retrying: transient server and throughput conditions. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`payment aggregator circuit is open; retry in ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

export class PaHttpClient {
  private readonly agent: Agent;
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetAfterMs: number;

  readonly metrics = { requests: 0, failures: 0, retries: 0, circuitTrips: 0, totalLatencyMs: 0 };

  constructor(private readonly options: HttpClientOptions) {
    this.failureThreshold = options.circuitBreaker?.failureThreshold ?? 8;
    this.resetAfterMs = options.circuitBreaker?.resetAfterMs ?? 15_000;
    this.agent = new Agent({
      connections: 64,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
      connectTimeout: Math.min(options.timeoutMs, 8_000),
    });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  get circuitState(): BreakerState {
    return this.state;
  }

  private checkCircuit(): void {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.resetAfterMs) throw new CircuitOpenError(this.resetAfterMs - elapsed);
      this.state = 'half_open';
      this.options.logger.warn('payment aggregator circuit entering half-open');
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== 'closed') {
      this.state = 'closed';
      this.options.logger.info('payment aggregator circuit closed');
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    this.metrics.failures++;
    if (this.state === 'half_open' || this.consecutiveFailures >= this.failureThreshold) {
      if (this.state !== 'open') this.metrics.circuitTrips++;
      this.state = 'open';
      this.openedAt = Date.now();
      this.options.logger.error(
        { consecutiveFailures: this.consecutiveFailures },
        'payment aggregator circuit opened',
      );
    }
  }

  async send<T>(args: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    headers?: Record<string, string>;
    /** GET and explicitly-idempotent writes may be retried. */
    retryable?: boolean;
  }): Promise<HttpResponse<T>> {
    this.checkCircuit();

    const requestId = randomUUID();
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${args.path}`;
    const isRetryable = args.retryable ?? (args.method === 'GET' || !!args.idempotencyKey);
    const attempts = isRetryable ? this.options.maxRetries + 1 : 1;

    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const started = Date.now();
      this.metrics.requests++;
      try {
        const headers: Record<string, string> = {
          ...this.options.defaultHeaders,
          ...args.headers,
          'x-request-id': requestId,
          accept: 'application/json',
        };
        if (args.body !== undefined) headers['content-type'] = 'application/json';
        if (args.idempotencyKey) headers['x-idempotency-key'] = args.idempotencyKey;

        const res = await request(url, {
          method: args.method,
          headers,
          body: args.body === undefined ? undefined : JSON.stringify(args.body),
          dispatcher: this.agent,
          headersTimeout: this.options.timeoutMs,
          bodyTimeout: this.options.timeoutMs,
        });

        const text = await res.body.text();
        const latencyMs = Date.now() - started;
        this.metrics.totalLatencyMs += latencyMs;

        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.recordSuccess();
          return { status: res.statusCode, body: parsed as T, requestId, latencyMs };
        }

        const retriable = RETRYABLE_STATUS.has(res.statusCode);
        const error = err.upstream(
          `pa.http_${res.statusCode}`,
          `payment aggregator returned ${res.statusCode} for ${args.method} ${args.path}`,
          { status: res.statusCode, body: parsed, requestId, path: args.path },
        );

        if (!retriable || attempt === attempts) {
          if (res.statusCode >= 500) this.recordFailure();
          else this.recordSuccess(); // a 4xx is our fault, not an outage
          throw error;
        }

        lastError = error;
        this.metrics.retries++;
        await this.backoff(attempt, res.headers['retry-after']);
      } catch (e) {
        this.metrics.totalLatencyMs += Date.now() - started;
        if (e instanceof CircuitOpenError) throw e;

        const code = (e as { code?: string })?.code;
        const isNetwork = !!code && RETRYABLE_ERROR_CODES.has(code);
        const isOurError = (e as { name?: string })?.name === 'AppError';

        if (isOurError && attempt === attempts) throw e;
        if (!isNetwork && !isOurError) {
          this.recordFailure();
          throw err.upstream('pa.transport_error', `transport failure calling ${args.path}`, { code }, e);
        }
        if (attempt === attempts) {
          this.recordFailure();
          throw isOurError
            ? e
            : err.upstream('pa.transport_error', `transport failure calling ${args.path}`, { code }, e);
        }
        lastError = e;
        this.metrics.retries++;
        this.recordFailure();
        await this.backoff(attempt);
      }
    }

    throw lastError ?? err.upstream('pa.unknown', 'payment aggregator call failed');
  }

  private async backoff(attempt: number, retryAfterHeader?: string | string[]): Promise<void> {
    const hinted = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    const hintedMs = hinted ? Number(hinted) * 1000 : NaN;
    const base = Number.isFinite(hintedMs) ? hintedMs : Math.min(2_000, 100 * 2 ** (attempt - 1));
    const jittered = Math.random() * base; // full jitter
    await new Promise((r) => setTimeout(r, Math.max(25, jittered)));
  }
}
