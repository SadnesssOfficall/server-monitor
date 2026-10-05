import { mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { TargetGuard } from '../src/core/ssrf.js';
import type { Monitor } from '../src/core/types.js';
import { TEST_CERT, TEST_KEY } from './fixtures/tls.js';

type Closer = () => Promise<void>;
type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const cleanups: Closer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

export const openGuard = new TargetGuard({ allowPrivateTargets: true });

export interface TestServer {
  port: number;
  url: string;
  requests: string[];
}

function listen(server: net.Server, scheme: string): Promise<TestServer> {
  server.unref();
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      }),
  );
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, url: `${scheme}://127.0.0.1:${port}`, requests: [] });
    });
  });
}

export async function startHttp(handler: Handler): Promise<TestServer> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
    handler(request, response);
  });
  const started = await listen(server, 'http');
  return { ...started, requests };
}

export async function startHttps(handler: Handler): Promise<TestServer> {
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, handler);
  return listen(server, 'https');
}

export function startTcp(): Promise<TestServer> {
  return listen(
    net.createServer((socket) => {
      socket.on('error', () => undefined);
    }),
    'tcp',
  );
}

export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}

export function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'server-monitor-'));
  directories.push(directory);
  return directory;
}

export function makeMonitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 'monitor-1',
    name: 'Example',
    type: 'http',
    target: 'http://127.0.0.1:1/',
    enabled: true,
    intervalSeconds: 60,
    timeoutMs: 2000,
    expectedStatus: { min: 200, max: 299 },
    maxRedirects: 5,
    failureThreshold: 3,
    recoveryThreshold: 1,
    keyword: null,
    keywordMode: 'present',
    maxBodyBytes: 262_144,
    certExpiryWarnDays: 14,
    notificationCooldownSeconds: 900,
    channelIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export { TEST_CERT };
