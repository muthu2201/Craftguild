/** Domain and application error taxonomy. Every error carries a stable code. */

export type ErrorCategory =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'precondition'
  | 'rate_limited'
  | 'upstream'
  | 'internal';

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition: 422,
  rate_limited: 429,
  upstream: 502,
  internal: 500,
};

export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    category: ErrorCategory = 'internal',
    details: Record<string, unknown> = {},
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.category = category;
    this.details = details;
    this.retryable = options.retryable ?? category === 'upstream';
  }

  get httpStatus(): number {
    return STATUS_BY_CATEGORY[this.category];
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const err = {
  validation: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(code, message, 'validation', details),
  notFound: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(code, message, 'not_found', details),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(code, message, 'conflict', details),
  unauthorized: (code: string, message: string) => new AppError(code, message, 'unauthorized'),
  forbidden: (code: string, message: string) => new AppError(code, message, 'forbidden'),
  precondition: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(code, message, 'precondition', details),
  rateLimited: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(code, message, 'rate_limited', details),
  upstream: (code: string, message: string, details?: Record<string, unknown>, cause?: unknown) =>
    new AppError(code, message, 'upstream', details, { retryable: true, cause }),
  internal: (code: string, message: string, details?: Record<string, unknown>, cause?: unknown) =>
    new AppError(code, message, 'internal', details, { cause }),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
