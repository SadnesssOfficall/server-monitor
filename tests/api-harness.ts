import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach } from 'vitest';
import { createApiServer } from '../src/api/server.js';
import { TargetGuard } from '../src/core/ssrf.js';
import { MS_PER_DAY } from '../src/core/types.js';
import { silentLogger } from '../src/logger.js';
import { MemoryStorage } from '../src/storage/memory.js';

export const TOKEN = 'test-token-0123456789-abcdefghij';
export const NOW = 100 * MS_PER_DAY;

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

export const api: {
  base: string;
  storage: MemoryStorage;
  allowPrivate: boolean;
  close: () => Promise<void>;
} = { base: '', storage: new MemoryStorage(), allowPrivate: false, close: () => Promise.resolve() };

export async function boot(): Promise<void> {
  api.storage = new MemoryStorage();
  const server = createApiServer({
    storage: api.storage,
    guard: new TargetGuard({ allowPrivateTargets: api.allowPrivate }),
    token: TOKEN,
    logger: silentLogger,
    now: () => NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
}

export async function call(
  method: string,
  path: string,
  options: { body?: unknown; raw?: string; token?: string | null; type?: string | null } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const payload =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (payload !== undefined && options.type !== null) {
    headers['Content-Type'] = options.type ?? 'application/json';
  }
  const response = await fetch(`${api.base}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : JSON.parse(text),
    headers: response.headers,
  };
}

export const validMonitor = {
  name: 'Site',
  type: 'https',
  target: 'https://example.com/health',
};

export function useApi(): void {
  beforeEach(async () => {
    api.allowPrivate = false;
    await boot();
  });

  afterEach(async () => {
    await api.close();
  });
}
