import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '../src/core/types.js';
import { makeMonitor } from './helpers.js';
import { api, call, NOW, useApi, validMonitor } from './api-harness.js';

useApi();

describe('stats, history and incidents', () => {
  async function seed() {
    const monitor = makeMonitor({ id: 'seeded', intervalSeconds: 60 });
    await api.storage.saveMonitor(monitor);
    for (let minute = 0; minute < 120; minute++) {
      const ok = minute < 90;
      await api.storage.appendCheck({
        monitorId: 'seeded',
        timestamp: NOW - (120 - minute) * 60_000,
        ok,
        responseTimeMs: ok ? 100 + minute : null,
        statusCode: ok ? 200 : null,
        error: ok ? null : 'timeout',
        certExpiresAt: null,
      });
    }
    await api.storage.saveIncident({
      id: 'inc-1',
      monitorId: 'seeded',
      startedAt: NOW - 30 * 60_000,
      resolvedAt: null,
      cause: 'timeout',
    });
    await api.storage.saveIncident({
      id: 'inc-0',
      monitorId: 'seeded',
      startedAt: NOW - 5 * MS_PER_DAY,
      resolvedAt: NOW - 5 * MS_PER_DAY + 600_000,
      cause: 'HTTP 503',
    });
  }

  it('computes uptime windows and response times', async () => {
    await seed();
    const { body } = await call('GET', '/v1/monitors/seeded');
    expect(body.stats.uptime['24h'].uptimePercent).toBeCloseTo(75, 0);
    expect(body.stats.uptime['24h'].downtimeMs).toBeGreaterThan(0);
    expect(body.stats.uptime['30d'].uptimePercent).toBeCloseTo(75, 0);
    expect(body.stats.responseTime24h).toMatchObject({ samples: 90 });
    expect(body.stats.responseTime24h.p95Ms).toBeGreaterThan(body.stats.responseTime24h.averageMs);
  });

  it('pages check history newest first and validates query parameters', async () => {
    await seed();
    const page = await call('GET', '/v1/monitors/seeded/checks?limit=5');
    expect(page.body.checks).toHaveLength(5);
    expect(page.body.checks[0].timestamp).toBeGreaterThan(page.body.checks[4].timestamp);
    const window = await call(
      'GET',
      `/v1/monitors/seeded/checks?since=${NOW - 600_000}&until=${NOW}`,
    );
    expect(window.body.checks.length).toBeLessThanOrEqual(11);
    for (const query of ['limit=0', 'limit=abc', 'limit=1001', 'since=-1', 'until=x']) {
      expect((await call('GET', `/v1/monitors/seeded/checks?${query}`)).status).toBe(422);
    }
  });

  it('lists incidents with durations for a monitor and globally', async () => {
    await seed();
    const mine = await call('GET', '/v1/monitors/seeded/incidents');
    expect(mine.body.incidents.map((entry: { id: string }) => entry.id)).toEqual([
      'inc-1',
      'inc-0',
    ]);
    expect(mine.body.incidents[0]).toMatchObject({ ongoing: true, durationMs: 30 * 60_000 });
    expect(mine.body.incidents[1]).toMatchObject({ ongoing: false, durationMs: 600_000 });
    const open = await call('GET', '/v1/incidents?open=true');
    expect(open.body.incidents).toHaveLength(1);
    expect((await call('GET', '/v1/incidents')).body.incidents).toHaveLength(2);
  });
});

describe('notification channels', () => {
  const hookUrl = 'https://hooks.example.com/services/T000/B000/TOPSECRETPATH?key=QUERYSECRET';

  it('masks target URLs and never returns stored secrets', async () => {
    const created = await call('POST', '/v1/channels', {
      body: { type: 'webhook', name: 'ops', url: hookUrl },
    });
    expect(created.status).toBe(201);
    expect(created.body.signingSecret).toMatch(/^[0-9a-f]{64}$/);
    const listed = await call('GET', '/v1/channels');
    const single = await call('GET', `/v1/channels/${created.body.channel.id}`);
    for (const response of [created, listed, single]) {
      const text = JSON.stringify(response.body.channel ?? response.body.channels);
      expect(text).not.toContain('TOPSECRETPATH');
      expect(text).not.toContain('QUERYSECRET');
      expect(text).toContain('https://hooks.example.com/***');
    }
    expect(JSON.stringify(listed.body)).not.toContain(created.body.signingSecret);
    expect(JSON.stringify(single.body)).not.toContain('secret');
  });

  it('masks discord webhook tokens', async () => {
    const response = await call('POST', '/v1/channels', {
      body: { type: 'discord', name: 'd', url: 'https://discord.com/api/webhooks/123/TOKEN-VALUE' },
    });
    expect(JSON.stringify(response.body)).not.toContain('TOKEN-VALUE');
    expect(response.body.channel.url).toBe('https://discord.com/***');
  });

  it('hides smtp credentials and masks addresses', async () => {
    const response = await call('POST', '/v1/channels', {
      body: {
        type: 'email',
        name: 'mail',
        host: 'smtp.example.com',
        port: 587,
        username: 'smtp-user',
        password: 'smtp-password-123',
        from: 'monitor@example.com',
        to: ['ops@example.com'],
      },
    });
    expect(response.status).toBe(201);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('smtp-password-123');
    expect(text).not.toContain('smtp-user');
    expect(text).not.toContain('ops@example.com');
    expect(response.body.channel).toMatchObject({ security: 'starttls', authenticated: true });
    const stored = (await api.storage.listChannels())[0];
    expect(stored).toMatchObject({ password: 'smtp-password-123' });
  });

  it.each([
    ['unknown type', { type: 'sms', name: 'x' }],
    ['missing url', { type: 'discord', name: 'x' }],
    ['ftp url', { type: 'webhook', name: 'x', url: 'ftp://example.com' }],
    ['credentials in url', { type: 'webhook', name: 'x', url: 'https://u:p@example.com' }],
    ['short secret', { type: 'webhook', name: 'x', url: 'https://example.com', secret: 'short' }],
    ['webhook with smtp fields', { type: 'webhook', name: 'x', url: 'https://e.com', host: 'h' }],
    [
      'email without recipients',
      { type: 'email', name: 'x', host: 'h.example', from: 'a@b.co', to: [] },
    ],
    [
      'email bad recipient',
      { type: 'email', name: 'x', host: 'h.example', from: 'a@b.co', to: ['nope'] },
    ],
    [
      'email half credentials',
      {
        type: 'email',
        name: 'x',
        host: 'h.example',
        from: 'a@b.co',
        to: ['c@d.co'],
        username: 'u',
      },
    ],
    [
      'email bad security',
      {
        type: 'email',
        name: 'x',
        host: 'h.example',
        from: 'a@b.co',
        to: ['c@d.co'],
        security: 'none',
      },
    ],
    [
      'email bad port',
      { type: 'email', name: 'x', host: 'h.example', from: 'a@b.co', to: ['c@d.co'], port: 0 },
    ],
  ])('rejects %s', async (_label, body) => {
    expect((await call('POST', '/v1/channels', { body })).status).toBe(422);
    expect(await api.storage.listChannels()).toEqual([]);
  });

  it('accepts a caller supplied signing secret and does not echo it', async () => {
    const response = await call('POST', '/v1/channels', {
      body: {
        type: 'webhook',
        name: 'x',
        url: 'https://example.com/h',
        secret: 'caller-chosen-secret-123',
      },
    });
    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toContain('caller-chosen-secret-123');
  });

  it('detaches a deleted channel from monitors', async () => {
    const channel = (
      await call('POST', '/v1/channels', {
        body: { type: 'discord', name: 'd', url: 'https://discord.com/api/webhooks/1/a' },
      })
    ).body.channel;
    const monitor = (
      await call('POST', '/v1/monitors', { body: { ...validMonitor, channelIds: [channel.id] } })
    ).body.monitor;
    expect((await call('DELETE', `/v1/channels/${channel.id}`)).status).toBe(200);
    expect((await api.storage.getMonitor(monitor.id))?.channelIds).toEqual([]);
    expect((await call('GET', `/v1/channels/${channel.id}`)).status).toBe(404);
  });
});
