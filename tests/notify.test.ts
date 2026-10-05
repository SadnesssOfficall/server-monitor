import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TargetGuard } from '../src/core/ssrf.js';
import { DiscordNotifier } from '../src/notify/discord.js';
import { NotificationDispatcher } from '../src/notify/dispatcher.js';
import { formatDuration } from '../src/notify/format.js';
import { NotifyError, withRetry } from '../src/notify/retry.js';
import type { NotificationEvent, WebhookChannel } from '../src/notify/types.js';
import {
  EVENT_HEADER,
  SIGNATURE_HEADER,
  signPayload,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
  WebhookNotifier,
} from '../src/notify/webhook.js';
import { MemoryStorage } from '../src/storage/memory.js';
import { makeMonitor, openGuard, startHttp } from './helpers.js';

const SECRET = 'super-secret-signing-key';
const event: NotificationEvent = {
  kind: 'incident_opened',
  at: Date.UTC(2026, 9, 5, 12, 0, 0),
  monitor: { id: 'monitor-1', name: 'API', type: 'http', target: 'https://example.com/' },
  incident: {
    id: 'incident-1',
    startedAt: Date.UTC(2026, 9, 5, 11, 59, 0),
    resolvedAt: null,
    durationMs: 60_000,
    cause: 'timeout',
  },
  certificate: null,
};

async function readBody(request: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

describe('webhook signatures', () => {
  const body = '{"a":1}';
  const timestamp = '1000';
  const now = 1_000_000;

  it('signs with HMAC-SHA256 over timestamp and body', () => {
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    expect(signPayload(SECRET, timestamp, body)).toBe(`sha256=${expected}`);
  });

  it('verifies a valid signature', () => {
    const signature = signPayload(SECRET, timestamp, body);
    expect(verifyWebhookSignature({ secret: SECRET, timestamp, body, signature, now })).toBe(true);
  });

  it('rejects a tampered body, wrong secret and truncated signature', () => {
    const signature = signPayload(SECRET, timestamp, body);
    expect(
      verifyWebhookSignature({ secret: SECRET, timestamp, body: '{"a":2}', signature, now }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({ secret: 'other-secret-value', timestamp, body, signature, now }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        body,
        signature: signature.slice(0, -2),
        now,
      }),
    ).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, timestamp, body, signature: '', now })).toBe(
      false,
    );
  });

  it('rejects replays outside the tolerance window', () => {
    const signature = signPayload(SECRET, timestamp, body);
    const late = 1_000_000 + 301_000;
    expect(verifyWebhookSignature({ secret: SECRET, timestamp, body, signature, now: late })).toBe(
      false,
    );
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        body,
        signature,
        now: late,
        toleranceSeconds: 600,
      }),
    ).toBe(true);
  });

  it('rejects a swapped timestamp and non-numeric timestamps', () => {
    const signature = signPayload(SECRET, timestamp, body);
    expect(
      verifyWebhookSignature({ secret: SECRET, timestamp: '1001', body, signature, now }),
    ).toBe(false);
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: 'abc', body, signature, now })).toBe(
      false,
    );
  });
});

describe('webhook delivery', () => {
  it('posts a signed JSON payload that the receiver can verify', async () => {
    let received: { body: string; headers: Record<string, string | string[] | undefined> } | null =
      null;
    const server = await startHttp((request, response) => {
      void readBody(request).then((body) => {
        received = { body, headers: request.headers };
        response.end('ok');
      });
    });
    const channel: WebhookChannel = {
      id: 'c',
      name: 'hook',
      type: 'webhook',
      url: `${server.url}/hook`,
      secret: SECRET,
      createdAt: 0,
    };
    const notifier = new WebhookNotifier(channel, (signal) => ({ guard: openGuard, signal }));
    await notifier.send(event, AbortSignal.timeout(2000));
    expect(received).not.toBeNull();
    const { body, headers } = received as unknown as NonNullable<typeof received>;
    expect(headers[EVENT_HEADER.toLowerCase()]).toBe('incident_opened');
    const signature = String(headers[SIGNATURE_HEADER.toLowerCase()]);
    const timestamp = String(headers[TIMESTAMP_HEADER.toLowerCase()]);
    expect(verifyWebhookSignature({ secret: SECRET, timestamp, body, signature })).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      kind: 'incident_opened',
      monitor: { id: 'monitor-1' },
    });
    expect(body).not.toContain(SECRET);
  });

  it('refuses to post to private addresses by default', async () => {
    const server = await startHttp((_request, response) => response.end('ok'));
    const channel: WebhookChannel = {
      id: 'c',
      name: 'hook',
      type: 'webhook',
      url: server.url,
      secret: SECRET,
      createdAt: 0,
    };
    const guard = new TargetGuard();
    const notifier = new WebhookNotifier(channel, (signal) => ({ guard, signal }));
    await expect(notifier.send(event, AbortSignal.timeout(2000))).rejects.toThrow('blocked');
    expect(server.requests).toEqual([]);
  });
});

describe('discord delivery', () => {
  it('posts an embed without mentions', async () => {
    let body = '';
    const server = await startHttp((request, response) => {
      void readBody(request).then((text) => {
        body = text;
        response.statusCode = 204;
        response.end();
      });
    });
    const notifier = new DiscordNotifier(
      {
        id: 'd',
        name: 'discord',
        type: 'discord',
        url: `${server.url}/api/webhooks/1/token`,
        createdAt: 0,
      },
      (signal) => ({ guard: openGuard, signal }),
    );
    await notifier.send(event, AbortSignal.timeout(2000));
    const payload = JSON.parse(body) as {
      allowed_mentions: { parse: string[] };
      embeds: { title: string; description: string }[];
    };
    expect(payload.allowed_mentions.parse).toEqual([]);
    expect(payload.embeds[0]?.title).toBe('DOWN: API');
    expect(payload.embeds[0]?.description).toContain('Cause: timeout');
  });

  it('classifies HTTP errors', async () => {
    const server = await startHttp((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const notifier = new DiscordNotifier(
      { id: 'd', name: 'discord', type: 'discord', url: server.url, createdAt: 0 },
      (signal) => ({ guard: openGuard, signal }),
    );
    await expect(notifier.send(event, AbortSignal.timeout(2000))).rejects.toMatchObject({
      message: 'HTTP 404',
      retryable: false,
    });
  });
});

describe('withRetry', () => {
  const sleeps: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return Promise.resolve();
  };

  it('retries retryable failures with exponential backoff', async () => {
    sleeps.length = 0;
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(new NotifyError('HTTP 500', true))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('done');
    await expect(withRetry(operation, { attempts: 3, baseDelayMs: 100, sleep })).resolves.toBe(
      'done',
    );
    expect(sleeps).toEqual([100, 200]);
  });

  it('does not retry permanent failures', async () => {
    const operation = vi.fn().mockRejectedValue(new NotifyError('HTTP 400', false));
    await expect(withRetry(operation, { attempts: 5, baseDelayMs: 1, sleep })).rejects.toThrow(
      'HTTP 400',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt limit', async () => {
    const operation = vi.fn().mockRejectedValue(new NotifyError('HTTP 503', true));
    await expect(withRetry(operation, { attempts: 3, baseDelayMs: 1, sleep })).rejects.toThrow(
      'HTTP 503',
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe('dispatcher', () => {
  it('retries a flaky webhook, reports failures and never leaks secrets', async () => {
    let hits = 0;
    const server = await startHttp((_request, response) => {
      hits += 1;
      response.statusCode = hits < 3 ? 503 : 200;
      response.end();
    });
    const storage = new MemoryStorage();
    await storage.saveMonitor(makeMonitor({ channelIds: ['good', 'dead', 'missing'] }));
    await storage.saveChannel({
      id: 'good',
      name: 'good',
      type: 'webhook',
      url: `${server.url}/hook?token=URLSECRET`,
      secret: SECRET,
      createdAt: 0,
    });
    await storage.saveChannel({
      id: 'dead',
      name: 'dead',
      type: 'discord',
      url: 'http://127.0.0.1:1/URLSECRET',
      createdAt: 0,
    });
    const dispatcher = new NotificationDispatcher({
      storage,
      guard: openGuard,
      baseDelayMs: 1,
      attempts: 3,
      sleep: () => Promise.resolve(),
    });
    const results = await dispatcher.dispatch(
      makeMonitor({ channelIds: ['good', 'dead', 'missing'] }),
      event,
    );
    expect(results.find((entry) => entry.channelId === 'good')).toMatchObject({ delivered: true });
    const dead = results.find((entry) => entry.channelId === 'dead');
    expect(dead).toMatchObject({ delivered: false, error: 'network: ECONNREFUSED' });
    expect(hits).toBe(3);
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results)).not.toContain('URLSECRET');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [61_000, '1m 1s'],
    [3_600_000, '1h'],
    [90_061_000, '1d 1h 1m 1s'],
    [-5, '0s'],
  ])('formats %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
