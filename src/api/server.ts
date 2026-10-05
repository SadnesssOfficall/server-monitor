import http from 'node:http';
import type { TargetGuard } from '../core/ssrf.js';
import type { Logger } from '../logger.js';
import type { Storage } from '../storage/types.js';
import { ValidationError } from '../validation/fields.js';
import { bearerToken, HttpError, readJsonBody, sendJson, tokenMatches } from './http-utils.js';
import { route } from './routes.js';

export interface ApiOptions {
  storage: Storage;
  guard: TargetGuard;
  token: string;
  logger: Logger;
  now?: () => number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5000;
const MAX_HEADER_BYTES = 16 * 1024;
const API_PREFIX = 'v1';
const HEALTH_PATH = '/health';
const PLACEHOLDER_ORIGIN = 'http://localhost';

function errorBody(code: string, message: string, details?: unknown): unknown {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function createApiServer(options: ApiOptions): http.Server {
  const now = options.now ?? Date.now;
  const context = { storage: options.storage, guard: options.guard, now };

  const handle = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', PLACEHOLDER_ORIGIN);
    if (url.pathname === HEALTH_PATH) {
      if (request.method !== 'GET')
        throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    const supplied = bearerToken(request);
    if (supplied === null || !tokenMatches(supplied, options.token)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'unauthorized', 'a valid bearer token is required');
    }
    const [prefix, ...segments] = url.pathname.split('/').filter((part) => part !== '');
    if (prefix !== API_PREFIX || segments.length === 0) {
      throw new HttpError(404, 'not_found', 'resource not found');
    }
    const result = await route(context, {
      method: request.method ?? 'GET',
      segments: segments.map((part) => decodeURIComponent(part)),
      query: url.searchParams,
      readBody: () => readJsonBody(request),
    });
    sendJson(response, result.status, result.body);
  };

  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
      } else if (error instanceof HttpError) {
        sendJson(response, error.status, errorBody(error.code, error.message, error.details));
      } else if (error instanceof ValidationError) {
        sendJson(response, 422, errorBody('validation_failed', error.message, error.issues));
      } else if (error instanceof URIError) {
        sendJson(response, 400, errorBody('bad_request', 'malformed request path'));
      } else {
        options.logger.log('error', 'unhandled request error', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        sendJson(response, 500, errorBody('internal_error', 'internal server error'));
      }
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  return server;
}
