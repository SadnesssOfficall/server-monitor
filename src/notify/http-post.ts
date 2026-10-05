import { abortable } from '../core/deadline.js';
import { sendRequest } from '../core/http-request.js';
import type { TargetGuard } from '../core/ssrf.js';
import { NotifyError } from './retry.js';

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SUCCESS_MAX = 299;
const HTTP_SUCCESS_MIN = 200;

export interface PostContext {
  guard: TargetGuard;
  signal: AbortSignal;
  ca?: string | Buffer;
}

export async function postJson(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  context: PostContext,
): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new NotifyError('unsupported protocol', false);
  }
  const target = await abortable(context.guard.resolve(url.hostname), context.signal);
  const response = await sendRequest({
    url,
    target,
    signal: context.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
    maxBodyBytes: 0,
    ...(context.ca === undefined ? {} : { ca: context.ca }),
  });
  const { statusCode } = response;
  if (statusCode >= HTTP_SUCCESS_MIN && statusCode <= HTTP_SUCCESS_MAX) return;
  const retryable =
    statusCode === HTTP_TOO_MANY_REQUESTS ||
    statusCode >= HTTP_SERVER_ERROR ||
    statusCode < HTTP_CLIENT_ERROR;
  throw new NotifyError(`HTTP ${statusCode}`, retryable);
}
