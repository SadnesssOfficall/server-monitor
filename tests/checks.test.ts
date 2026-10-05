import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/core/run-check.js';
import { TargetGuard } from '../src/core/ssrf.js';
import {
  closedPort,
  makeMonitor,
  openGuard,
  startHttp,
  startHttps,
  startTcp,
  TEST_CERT,
} from './helpers.js';

const run = (monitor: ReturnType<typeof makeMonitor>, ca?: string) =>
  runCheck(monitor, { guard: openGuard, ...(ca === undefined ? {} : { ca }) });

describe('http checks', () => {
  it('reports up with status code and response time', async () => {
    const server = await startHttp((_request, response) => response.end('hello'));
    const outcome = await run(makeMonitor({ target: `${server.url}/health?x=1` }));
    expect(outcome).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(outcome.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(server.requests).toEqual(['GET /health?x=1']);
  });

  it('reports down when the connection is refused', async () => {
    const port = await closedPort();
    const outcome = await run(makeMonitor({ target: `http://127.0.0.1:${port}/` }));
    expect(outcome).toMatchObject({ ok: false, error: 'network: ECONNREFUSED' });
  });

  it('times out when the server never answers', async () => {
    const server = await startHttp(() => undefined);
    const started = Date.now();
    const outcome = await run(makeMonitor({ target: server.url, timeoutMs: 300 }));
    expect(outcome).toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports a wrong status code', async () => {
    const server = await startHttp((_request, response) => {
      response.statusCode = 503;
      response.end();
    });
    const outcome = await run(makeMonitor({ target: server.url }));
    expect(outcome).toMatchObject({ ok: false, statusCode: 503, error: 'unexpected status 503' });
  });

  it('honours a custom expected status range', async () => {
    const server = await startHttp((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const monitor = makeMonitor({ target: server.url, expectedStatus: { min: 404, max: 404 } });
    expect((await run(monitor)).ok).toBe(true);
  });

  it('follows redirects up to the limit', async () => {
    const server = await startHttp((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { Location: '/landing' });
        response.end();
      } else {
        response.end('landed');
      }
    });
    const outcome = await run(makeMonitor({ target: server.url }));
    expect(outcome.ok).toBe(true);
    expect(server.requests).toEqual(['GET /', 'GET /landing']);
  });

  it('does not follow redirects when the policy is zero', async () => {
    const server = await startHttp((_request, response) => {
      response.writeHead(301, { Location: '/elsewhere' });
      response.end();
    });
    const outcome = await run(makeMonitor({ target: server.url, maxRedirects: 0 }));
    expect(outcome).toMatchObject({ ok: false, statusCode: 301 });
    expect(server.requests).toHaveLength(1);
  });

  it('accepts a redirect status when it is expected and not followed', async () => {
    const server = await startHttp((_request, response) => {
      response.writeHead(301, { Location: '/elsewhere' });
      response.end();
    });
    const monitor = makeMonitor({
      target: server.url,
      maxRedirects: 0,
      expectedStatus: { min: 301, max: 301 },
    });
    expect((await run(monitor)).ok).toBe(true);
  });

  it('fails on redirect loops', async () => {
    const server = await startHttp((_request, response) => {
      response.writeHead(302, { Location: '/' });
      response.end();
    });
    const outcome = await run(makeMonitor({ target: server.url, maxRedirects: 3 }));
    expect(outcome).toMatchObject({ ok: false, error: 'too many redirects' });
    expect(server.requests).toHaveLength(4);
  });

  it('fails on an unparsable redirect location', async () => {
    const server = await startHttp((_request, response) => {
      response.writeHead(302, { Location: 'http://[bad' });
      response.end();
    });
    const outcome = await run(makeMonitor({ target: server.url }));
    expect(outcome.error).toBe('invalid redirect location');
  });

  it('does not leak the target URL or secrets through error text', async () => {
    const port = await closedPort();
    const outcome = await run(makeMonitor({ target: `http://127.0.0.1:${port}/?token=SECRET` }));
    expect(JSON.stringify(outcome)).not.toContain('SECRET');
  });
});

describe('keyword checks', () => {
  const keywordMonitor = (target: string, overrides = {}) =>
    makeMonitor({ type: 'keyword', target, keyword: 'pong', ...overrides });

  it('passes when the keyword is present', async () => {
    const server = await startHttp((_request, response) => response.end('ping pong'));
    expect((await run(keywordMonitor(server.url))).ok).toBe(true);
  });

  it('fails when the keyword is missing', async () => {
    const server = await startHttp((_request, response) => response.end('nothing here'));
    const outcome = await run(keywordMonitor(server.url));
    expect(outcome).toMatchObject({ ok: false, statusCode: 200, error: 'keyword not found' });
  });

  it('is case sensitive', async () => {
    const server = await startHttp((_request, response) => response.end('PONG'));
    expect((await run(keywordMonitor(server.url))).ok).toBe(false);
  });

  it('supports absent mode', async () => {
    const server = await startHttp((_request, response) => response.end('Fatal error'));
    const outcome = await run(
      keywordMonitor(server.url, { keyword: 'Fatal', keywordMode: 'absent' }),
    );
    expect(outcome).toMatchObject({ ok: false, error: 'forbidden keyword found' });
    const clean = await startHttp((_request, response) => response.end('all good'));
    const passing = await run(
      keywordMonitor(clean.url, { keyword: 'Fatal', keywordMode: 'absent' }),
    );
    expect(passing.ok).toBe(true);
  });

  it('only inspects the first maxBodyBytes of a large body', async () => {
    const server = await startHttp((_request, response) => {
      response.write('x'.repeat(5000));
      response.end('pong');
    });
    const outcome = await run(keywordMonitor(server.url, { maxBodyBytes: 1024 }));
    expect(outcome).toMatchObject({
      ok: false,
      error: 'keyword not found in first 1024 bytes',
    });
  });

  it('stops reading an endless body', async () => {
    const server = await startHttp((_request, response) => {
      const timer = setInterval(() => response.write('y'.repeat(4096)), 1);
      response.on('close', () => {
        clearInterval(timer);
      });
    });
    const outcome = await run(keywordMonitor(server.url, { maxBodyBytes: 2048, timeoutMs: 3000 }));
    expect(outcome.error).toContain('first 2048 bytes');
  });
});

describe('tcp checks', () => {
  it('connects to an open port', async () => {
    const server = await startTcp();
    const outcome = await run(makeMonitor({ type: 'tcp', target: `127.0.0.1:${server.port}` }));
    expect(outcome.ok).toBe(true);
  });

  it('reports a closed port', async () => {
    const port = await closedPort();
    const outcome = await run(makeMonitor({ type: 'tcp', target: `127.0.0.1:${port}` }));
    expect(outcome).toMatchObject({ ok: false, error: 'network: ECONNREFUSED' });
  });

  it.each(['127.0.0.1', '127.0.0.1:0', '127.0.0.1:70000', ':80', 'a b:80', 'host:80:90'])(
    'rejects the malformed target %s',
    async (target) => {
      const outcome = await run(makeMonitor({ type: 'tcp', target }));
      expect(outcome).toMatchObject({ ok: false, error: 'invalid target' });
    },
  );

  it('supports bracketed IPv6 literals', async () => {
    const port = await closedPort();
    const outcome = await run(makeMonitor({ type: 'tcp', target: `[::1]:${port}` }));
    expect(outcome.ok).toBe(false);
  });
});

describe('https checks', () => {
  it('validates the certificate and reports its expiry', async () => {
    const server = await startHttps((_request, response) => response.end('secure'));
    const outcome = await run(makeMonitor({ type: 'https', target: server.url }), TEST_CERT);
    expect(outcome.ok).toBe(true);
    expect(outcome.certExpiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects an untrusted certificate', async () => {
    const server = await startHttps((_request, response) => response.end('secure'));
    const outcome = await run(makeMonitor({ type: 'https', target: server.url }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/^tls: /);
  });

  it('rejects a hostname mismatch', async () => {
    const server = await startHttps((_request, response) => response.end('secure'));
    const guard = new TargetGuard({
      allowPrivateTargets: true,
      resolver: () => Promise.resolve(['127.0.0.1']),
    });
    const outcome = await runCheck(
      makeMonitor({ type: 'https', target: `https://wrong.example:${server.port}/` }),
      { guard, ca: TEST_CERT },
    );
    expect(outcome.error).toBe('tls: ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('works for keyword checks over TLS', async () => {
    const server = await startHttps((_request, response) => response.end('secure pong'));
    const outcome = await run(
      makeMonitor({ type: 'keyword', target: server.url, keyword: 'pong' }),
      TEST_CERT,
    );
    expect(outcome.ok).toBe(true);
  });

  it('rejects non-http redirect protocols over TLS', async () => {
    const server = await startHttps((_request, response) => {
      response.writeHead(302, { Location: 'ftp://example.com/' });
      response.end();
    });
    const outcome = await run(makeMonitor({ type: 'https', target: server.url }), TEST_CERT);
    expect(outcome.error).toBe('unsupported redirect protocol');
  });
});
