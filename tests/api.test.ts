import { describe, expect, it } from 'vitest';
import { api, call, NOW, TOKEN, useApi, validMonitor } from './api-harness.js';

useApi();

describe('authentication', () => {
  it('serves /health without credentials', async () => {
    const response = await call('GET', '/health', { token: null });
    expect(response).toMatchObject({ status: 200, body: { status: 'ok' } });
  });

  it.each([
    ['missing token', null],
    ['wrong token', 'wrong-token-0123456789-abcdefghij'],
    ['prefix of the token', TOKEN.slice(0, -1)],
    ['token with extra suffix', `${TOKEN}x`],
    ['empty token', ''],
  ])('rejects %s', async (_label, token) => {
    const response = await call('GET', '/v1/monitors', { token });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });

  it('rejects other authentication schemes', async () => {
    const response = await fetch(`${api.base}/v1/monitors`, {
      headers: { Authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString('base64')}` },
    });
    expect(response.status).toBe(401);
  });

  it('accepts the right token', async () => {
    expect((await call('GET', '/v1/monitors')).status).toBe(200);
  });

  it('requires auth before parsing bodies or revealing routes', async () => {
    expect((await call('POST', '/v1/monitors', { token: null, raw: '{bad' })).status).toBe(401);
    expect((await call('GET', '/v1/nope', { token: null })).status).toBe(401);
  });

  it('sets safe response headers', async () => {
    const response = await call('GET', '/v1/monitors');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('monitor CRUD and validation', () => {
  it('creates a monitor with defaults', async () => {
    const response = await call('POST', '/v1/monitors', { body: validMonitor });
    expect(response.status).toBe(201);
    expect(response.body.monitor).toMatchObject({
      name: 'Site',
      intervalSeconds: 60,
      failureThreshold: 3,
      expectedStatus: { min: 200, max: 299 },
      enabled: true,
      createdAt: NOW,
    });
    expect(await api.storage.listMonitors()).toHaveLength(1);
  });

  it('lists, reads, patches and deletes', async () => {
    const created = (await call('POST', '/v1/monitors', { body: validMonitor })).body.monitor;
    const list = await call('GET', '/v1/monitors');
    expect(list.body.monitors[0]).toMatchObject({ id: created.id, state: { status: 'pending' } });
    const patched = await call('PATCH', `/v1/monitors/${created.id}`, {
      body: { intervalSeconds: 30, failureThreshold: 5 },
    });
    expect(patched.body.monitor).toMatchObject({
      name: 'Site',
      intervalSeconds: 30,
      failureThreshold: 5,
      id: created.id,
    });
    const read = await call('GET', `/v1/monitors/${created.id}`);
    expect(read.body.monitor.intervalSeconds).toBe(30);
    expect((await call('DELETE', `/v1/monitors/${created.id}`)).status).toBe(200);
    expect((await call('GET', `/v1/monitors/${created.id}`)).status).toBe(404);
  });

  it.each([
    ['unknown field', { ...validMonitor, isAdmin: true }, 'isAdmin'],
    ['id injection', { ...validMonitor, id: 'x' }, 'id'],
    ['missing name', { type: 'https', target: 'https://example.com' }, 'name'],
    ['bad type', { ...validMonitor, type: 'ftp' }, 'type'],
    ['non-integer interval', { ...validMonitor, intervalSeconds: 1.5 }, 'intervalSeconds'],
    ['interval too small', { ...validMonitor, intervalSeconds: 1 }, 'intervalSeconds'],
    ['string interval', { ...validMonitor, intervalSeconds: '60' }, 'intervalSeconds'],
    [
      'timeout not below interval',
      { ...validMonitor, intervalSeconds: 10, timeoutMs: 10_000 },
      'timeoutMs',
    ],
    [
      'inverted status range',
      { ...validMonitor, expectedStatus: { min: 300, max: 200 } },
      'expectedStatus',
    ],
    ['status out of range', { ...validMonitor, expectedStatus: { min: 99, max: 200 } }, 'min'],
    ['threshold zero', { ...validMonitor, failureThreshold: 0 }, 'failureThreshold'],
    ['wrong protocol for https', { ...validMonitor, target: 'http://example.com' }, 'target'],
    ['credentials in URL', { ...validMonitor, target: 'https://u:p@example.com' }, 'target'],
    ['garbage URL', { ...validMonitor, target: 'not a url' }, 'target'],
    ['javascript URL', { ...validMonitor, type: 'http', target: 'javascript:alert(1)' }, 'target'],
    ['keyword monitor without keyword', { ...validMonitor, type: 'keyword' }, 'keyword'],
    ['control chars in name', { ...validMonitor, name: 'a\nb' }, 'name'],
    ['name too long', { ...validMonitor, name: 'a'.repeat(101) }, 'name'],
    ['tcp without port', { name: 't', type: 'tcp', target: 'example.com' }, 'target'],
    ['ping with URL', { name: 'p', type: 'ping', target: 'http://example.com' }, 'target'],
    [
      'too many channels',
      { ...validMonitor, channelIds: Array.from({ length: 21 }, (_, i) => `c${i}`) },
      'channelIds',
    ],
    ['bad channel id', { ...validMonitor, channelIds: ['../etc'] }, 'channelIds'],
    ['array body', [validMonitor], 'body'],
  ])('rejects %s', async (_label, body, field) => {
    const response = await call('POST', '/v1/monitors', { body });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_failed');
    expect(response.body.error.details.map((issue: { field: string }) => issue.field)).toContain(
      field,
    );
    expect(await api.storage.listMonitors()).toEqual([]);
  });

  it('reports every problem at once', async () => {
    const response = await call('POST', '/v1/monitors', {
      body: { type: 'nope', intervalSeconds: 0 },
    });
    expect(response.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects references to unknown channels', async () => {
    const response = await call('POST', '/v1/monitors', {
      body: { ...validMonitor, channelIds: ['ghost'] },
    });
    expect(response.status).toBe(422);
  });

  it('does not let a patch change immutable fields', async () => {
    const created = (await call('POST', '/v1/monitors', { body: validMonitor })).body.monitor;
    const response = await call('PATCH', `/v1/monitors/${created.id}`, {
      body: { createdAt: 1, id: 'other' },
    });
    expect(response.status).toBe(422);
    expect((await api.storage.getMonitor(created.id))?.createdAt).toBe(NOW);
  });

  it('validates the merged result of a patch', async () => {
    const created = (await call('POST', '/v1/monitors', { body: validMonitor })).body.monitor;
    const response = await call('PATCH', `/v1/monitors/${created.id}`, {
      body: { type: 'keyword' },
    });
    expect(response.status).toBe(422);
  });

  it.each(['/v1/monitors/..%2Fsecret', '/v1/monitors/%00', '/v1/monitors/' + 'a'.repeat(100)])(
    'treats malformed id %s as not found',
    async (path) => {
      expect((await call('GET', path)).status).toBe(404);
    },
  );

  it('rejects malformed percent-encoding', async () => {
    expect((await call('GET', '/v1/monitors/%E0%A4%A')).status).toBe(400);
  });
});
