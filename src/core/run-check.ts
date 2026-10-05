import { TimeoutError } from './deadline.js';
import { checkHttp } from './http-check.js';
import { failure, type CheckContext } from './outcome.js';
import { PingUnavailableError, checkPing } from './ping-check.js';
import { BlockedTargetError, ResolutionError, TargetGuard } from './ssrf.js';
import { checkTcp } from './tcp-check.js';
import type { CheckOutcome, Monitor } from './types.js';

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;
const TLS_CODE_PATTERN =
  /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/;

export interface RunCheckOptions {
  guard: TargetGuard;
  ca?: string | Buffer;
}

export function describeError(error: unknown, signal: AbortSignal): string {
  if (signal.aborted || error instanceof TimeoutError) return 'timeout';
  if (
    error instanceof BlockedTargetError ||
    error instanceof ResolutionError ||
    error instanceof PingUnavailableError
  ) {
    return error.message;
  }
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && ERROR_CODE_PATTERN.test(code)) {
    return TLS_CODE_PATTERN.test(code) ? `tls: ${code}` : `network: ${code}`;
  }
  return 'request failed';
}

export async function runCheck(monitor: Monitor, options: RunCheckOptions): Promise<CheckOutcome> {
  const signal = AbortSignal.timeout(monitor.timeoutMs);
  const context: CheckContext = {
    guard: options.guard,
    signal,
    ...(options.ca === undefined ? {} : { ca: options.ca }),
  };
  try {
    switch (monitor.type) {
      case 'http':
      case 'https':
      case 'keyword':
        return await checkHttp(monitor, context);
      case 'tcp':
        return await checkTcp(monitor, context);
      case 'ping':
        return await checkPing(monitor, context);
    }
  } catch (error) {
    return failure(describeError(error, signal));
  }
}
