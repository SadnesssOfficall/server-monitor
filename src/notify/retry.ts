import { setTimeout as delay } from 'node:timers/promises';
import { BlockedTargetError } from '../core/ssrf.js';

export class NotifyError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'NotifyError';
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof BlockedTargetError) return false;
  return !(error instanceof NotifyError) || error.retryable;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= options.attempts || !isRetryable(error)) throw error;
      await sleep(options.baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
