import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { TLSSocket } from 'node:tls';
import { performance } from 'node:perf_hooks';
import { pinnedLookup, type ResolvedTarget } from './ssrf.js';

const USER_AGENT = 'server-monitor';
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

export interface RequestOptions {
  url: URL;
  target: ResolvedTarget;
  signal: AbortSignal;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  maxBodyBytes: number;
  ca?: string | Buffer;
}

export interface RawResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  headersAt: number;
  completedAt: number;
  certExpiresAt: number | null;
}

function bareHostname(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

function certificateExpiry(socket: unknown): number | null {
  if (!(socket instanceof TLSSocket)) return null;
  const expiry = Date.parse(socket.getPeerCertificate().valid_to);
  return Number.isNaN(expiry) ? null : expiry;
}

export function sendRequest(options: RequestOptions): Promise<RawResponse> {
  const { url, target, signal, maxBodyBytes } = options;
  const secure = url.protocol === 'https:';
  const defaultPort = secure ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
  return new Promise<RawResponse>((resolve, reject) => {
    const request = (secure ? https : http).request(
      {
        hostname: bareHostname(url),
        port: url.port === '' ? defaultPort : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        agent: false,
        lookup: pinnedLookup(target),
        signal,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          ...options.headers,
        },
      },
      (response) => {
        const headersAt = performance.now();
        const certExpiresAt = secure ? certificateExpiry(response.socket) : null;
        const finish = (body: Buffer, truncated: boolean): void => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
            truncated,
            headersAt,
            completedAt: performance.now(),
            certExpiresAt,
          });
        };
        response.on('error', reject);
        if (maxBodyBytes === 0) {
          finish(Buffer.alloc(0), false);
          request.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          const remaining = maxBodyBytes - received;
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            finish(Buffer.concat(chunks), true);
            request.destroy();
            return;
          }
          chunks.push(chunk);
          received += chunk.length;
        });
        response.on('end', () => {
          finish(Buffer.concat(chunks), false);
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}
