import { performance } from 'node:perf_hooks';
import { abortable } from './deadline.js';
import { sendRequest } from './http-request.js';
import { failure, success, type CheckContext } from './outcome.js';
import type { CheckOutcome, Monitor } from './types.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

function nextLocation(current: URL, location: string): URL | null {
  try {
    return new URL(location, current);
  } catch {
    return null;
  }
}

function evaluateBody(monitor: Monitor, body: Buffer, truncated: boolean): string | null {
  if (monitor.type !== 'keyword' || monitor.keyword === null) return null;
  const found = body.toString('utf8').includes(monitor.keyword);
  if (monitor.keywordMode === 'present' && !found) {
    return truncated
      ? `keyword not found in first ${monitor.maxBodyBytes} bytes`
      : 'keyword not found';
  }
  return monitor.keywordMode === 'absent' && found ? 'forbidden keyword found' : null;
}

export async function checkHttp(monitor: Monitor, context: CheckContext): Promise<CheckOutcome> {
  const started = performance.now();
  const needsBody = monitor.type === 'keyword';
  let url = new URL(monitor.target);
  let certExpiresAt: number | null = null;
  for (let redirects = 0; ; redirects++) {
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) return failure('unsupported redirect protocol');
    const target = await abortable(context.guard.resolve(url.hostname), context.signal);
    const response = await sendRequest({
      url,
      target,
      signal: context.signal,
      maxBodyBytes: needsBody ? monitor.maxBodyBytes : 0,
      ...(context.ca === undefined ? {} : { ca: context.ca }),
    });
    certExpiresAt = response.certExpiresAt ?? certExpiresAt;
    const location = response.headers.location;
    if (monitor.maxRedirects > 0 && REDIRECT_STATUSES.has(response.statusCode) && location) {
      if (redirects >= monitor.maxRedirects)
        return failure('too many redirects', { certExpiresAt });
      const next = nextLocation(url, location);
      if (next === null) return failure('invalid redirect location', { certExpiresAt });
      url = next;
      continue;
    }
    const responseTimeMs = Math.round(
      (needsBody ? response.completedAt : response.headersAt) - started,
    );
    const details = { responseTimeMs, statusCode: response.statusCode, certExpiresAt };
    const { min, max } = monitor.expectedStatus;
    if (response.statusCode < min || response.statusCode > max) {
      return failure(`unexpected status ${response.statusCode}`, details);
    }
    const bodyError = evaluateBody(monitor, response.body, response.truncated);
    return bodyError === null ? success(details) : failure(bodyError, details);
  }
}
