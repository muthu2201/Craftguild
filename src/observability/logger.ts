import pino from 'pino';

export interface Logger {
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

const REDACT_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  '*.password',
  'req.headers.authorization',
  'req.headers["x-webhook-signature"]',
  'headers.authorization',
  'authorization',
  'secret',
  'secretKey',
  'jwt',
  'token',
  'pan',
  'gstin',
  'bankAccountNumber',
  'bank_account_number',
  'accountNumber',
  'upiVpa',
  'upi_vpa',
  '*.pan',
  '*.accountNumber',
];

export function createLogger(level = 'info', name = 'craftguild'): Logger {
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  }) as unknown as Logger;
}

/** A logger that discards everything; used by tests and the stress harness. */
export const silentLogger: Logger = createLogger('silent');
