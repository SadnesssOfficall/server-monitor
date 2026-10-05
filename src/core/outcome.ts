import type { TargetGuard } from './ssrf.js';
import type { CheckOutcome } from './types.js';

export interface CheckContext {
  guard: TargetGuard;
  signal: AbortSignal;
  ca?: string | Buffer;
}

interface OutcomeDetails {
  responseTimeMs?: number | null;
  statusCode?: number | null;
  certExpiresAt?: number | null;
}

export function success(details: OutcomeDetails): CheckOutcome {
  return {
    ok: true,
    responseTimeMs: details.responseTimeMs ?? null,
    statusCode: details.statusCode ?? null,
    error: null,
    certExpiresAt: details.certExpiresAt ?? null,
  };
}

export function failure(error: string, details: OutcomeDetails = {}): CheckOutcome {
  return {
    ok: false,
    responseTimeMs: details.responseTimeMs ?? null,
    statusCode: details.statusCode ?? null,
    error,
    certExpiresAt: details.certExpiresAt ?? null,
  };
}
