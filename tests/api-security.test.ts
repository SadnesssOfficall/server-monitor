import { describe, expect, it } from 'vitest';
import { api, boot, call, TOKEN, useApi, validMonitor } from './api-harness.js';

useApi();

describe('SSRF protections at the API', () => {
  it.each([
    ['loopback', 'http://127.0.0.1:8080/'],
    ['metadata service', 'http://169.254.169.254/latest/meta-data/'],
    ['private range', 'http://10.1.2.3/'],
    ['localhost', 'http://localhost/'],
    ['ipv6 loopback', 'http://[::1]/'],
    ['mapped ipv4', 'http://[::ffff:169.254.169.254]/'],
  ])('rejects %s targets by default', async (_label, target) => {
    const response = await call('POST', '/v1/monitors', {
      body: { name: 'x', type: 'http', target },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain('not allowed');
  });

  it('rejects private tcp and ping targets', async () => {
    expect(
      (
        await call('POST', '/v1/monitors', {
          body: { name: 'x', type: 'tcp', target: '10.0.0.1:22' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call('POST', '/v1/monitors', {
          body: { name: 'x', type: 'ping', target: '192.168.1.1' },
        })
      ).status,
    ).toBe(422);
  });

  it('accepts private targets when allowPrivateTargets is enabled', async () => {
    await api.close();
    api.allowPrivate = true;
    await boot();
    const response = await call('POST', '/v1/monitors', {
      body: { name: 'lan', type: 'http', target: 'http://192.168.1.10:8080/' },
    });
    expect(response.status).toBe(201);
  });
});

describe('request hardening', () => {
  it('rejects oversized bodies', async () => {
    const response = await call('POST', '/v1/monitors', {
      body: { ...validMonitor, name: 'a'.repeat(200_000) },
    });
    expect(response.status).toBe(413);
  });

  it('rejects oversized bodies sent without a content length', async () => {
    const response = await fetch(`${api.base}/v1/monitors`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"name":"${'a'.repeat(100_000)}"}`));
          controller.close();
        },
      }),
      duplex: 'half',
    });
    expect(response.status).toBe(413);
  });

  it('rejects non-JSON content types and invalid JSON', async () => {
    expect((await call('POST', '/v1/monitors', { raw: '{}', type: 'text/plain' })).status).toBe(
      415,
    );
    expect((await call('POST', '/v1/monitors', { raw: '{}', type: null })).status).toBe(415);
    const invalid = await call('POST', '/v1/monitors', { raw: '{"a":' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_json');
  });

  it('does not let prototype pollution payloads through', async () => {
    const response = await call('POST', '/v1/monitors', {
      raw: '{"name":"x","type":"https","target":"https://example.com","__proto__":{"admin":true}}',
    });
    expect(response.status).toBe(422);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('returns 404 and 405 for unknown routes and methods', async () => {
    expect((await call('GET', '/v1/unknown')).status).toBe(404);
    expect((await call('GET', '/other')).status).toBe(404);
    expect((await call('PUT', '/v1/monitors')).status).toBe(405);
    expect((await call('POST', '/health', { token: null, body: {} })).status).toBe(405);
  });

  it('never leaks internals in 500 responses', async () => {
    api.storage.listMonitors = () =>
      Promise.reject(new Error('secret connection string pg://u:p@h'));
    const response = await call('GET', '/v1/monitors');
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('pg://');
  });
});
