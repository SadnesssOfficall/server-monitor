import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, type CheckOutcome, type Monitor } from '../src/core/types.js';
import { silentLogger } from '../src/logger.js';
import { NotificationDispatcher } from '../src/notify/dispatcher.js';
import { MemoryStorage } from '../src/storage/memory.js';
import { processMonitor, type CheckRunner } from '../src/worker/process-check.js';
import { makeMonitor, openGuard, startHttp } from './helpers.js';

const UP: CheckOutcome = {
  ok: true,
  responseTimeMs: 20,
  statusCode: 200,
  error: null,
  certExpiresAt: null,
};
const DOWN: CheckOutcome = {
  ...UP,
  ok: false,
  responseTimeMs: null,
  statusCode: null,
  error: 'timeout',
};

async function harness(monitorOverrides: Partial<Monitor> = {}) {
  const received: { kind: string; incident: { durationMs: number } | null }[] = [];
  const server = await startHttp((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end('ok');
    });
  });
  const storage = new MemoryStorage();
  const monitor = makeMonitor({ failureThreshold: 2, channelIds: ['hook'], ...monitorOverrides });
  await storage.saveMonitor(monitor);
  await storage.saveChannel({
    id: 'hook',
    name: 'hook',
    type: 'webhook',
    url: server.url,
    secret: 'a-very-long-signing-secret',
    createdAt: 0,
  });
  let clock = 1_000_000;
  let next: CheckOutcome = UP;
  const runner: CheckRunner = () => Promise.resolve(next);
  const deps = {
    storage,
    dispatcher: new NotificationDispatcher({ storage, guard: openGuard, baseDelayMs: 1 }),
    logger: silentLogger,
    runner,
    now: () => clock,
  };
  return {
    storage,
    received,
    monitor,
    step: async (outcome: CheckOutcome, advanceMs = 60_000) => {
      clock += advanceMs;
      next = outcome;
      await processMonitor(monitor, deps);
    },
  };
}

describe('processMonitor', () => {
  it('records every check and keeps state up while healthy', async () => {
    const h = await harness();
    await h.step(UP);
    await h.step(UP);
    expect(await h.storage.listChecks('monitor-1')).toHaveLength(2);
    expect((await h.storage.getState('monitor-1'))?.status).toBe('up');
    expect(h.received).toEqual([]);
  });

  it('opens an incident only after the threshold and notifies once', async () => {
    const h = await harness();
    await h.step(UP);
    await h.step(DOWN);
    expect(await h.storage.listIncidents()).toEqual([]);
    await h.step(DOWN);
    await h.step(DOWN);
    const incidents = await h.storage.listIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ resolvedAt: null, cause: 'timeout' });
    expect(incidents[0]?.startedAt).toBe(1_000_000 + 120_000);
    expect(h.received.map((entry) => entry.kind)).toEqual(['incident_opened']);
  });

  it('resolves the incident, records its duration and notifies recovery', async () => {
    const h = await harness();
    await h.step(UP);
    await h.step(DOWN);
    await h.step(DOWN);
    await h.step(UP, 300_000);
    const [incident] = await h.storage.listIncidents();
    expect(incident?.resolvedAt).toBe(1_000_000 + 60_000 * 3 + 300_000);
    expect((await h.storage.getState('monitor-1'))?.openIncidentId).toBeNull();
    expect(h.received.map((entry) => entry.kind)).toEqual(['incident_opened', 'incident_resolved']);
    expect(h.received[1]?.incident?.durationMs).toBe(360_000);
  });

  it('does not open an incident for a flapping monitor', async () => {
    const h = await harness();
    for (const outcome of [UP, DOWN, UP, DOWN, UP, DOWN, UP]) await h.step(outcome);
    expect(await h.storage.listIncidents()).toEqual([]);
    expect(h.received).toEqual([]);
  });

  it('suppresses notification spam within the cooldown and skips unannounced recoveries', async () => {
    const h = await harness({ failureThreshold: 1, notificationCooldownSeconds: 3600 });
    await h.step(DOWN);
    await h.step(UP);
    await h.step(DOWN);
    await h.step(UP);
    expect(await h.storage.listIncidents()).toHaveLength(2);
    expect(h.received.map((entry) => entry.kind)).toEqual(['incident_opened', 'incident_resolved']);
  });

  it('notifies again after the cooldown elapsed', async () => {
    const h = await harness({ failureThreshold: 1, notificationCooldownSeconds: 60 });
    await h.step(DOWN);
    await h.step(UP);
    await h.step(DOWN, 120_000);
    expect(h.received.map((entry) => entry.kind)).toEqual([
      'incident_opened',
      'incident_resolved',
      'incident_opened',
    ]);
  });

  it('warns about expiring certificates once per day', async () => {
    const h = await harness({ certExpiryWarnDays: 14 });
    const expiresAt = 1_000_000 + 10 * MS_PER_DAY;
    await h.step({ ...UP, certExpiresAt: expiresAt });
    await h.step({ ...UP, certExpiresAt: expiresAt });
    expect(h.received.map((entry) => entry.kind)).toEqual(['certificate_expiring']);
    await h.step({ ...UP, certExpiresAt: expiresAt }, MS_PER_DAY);
    expect(h.received).toHaveLength(2);
  });

  it('stays quiet for certificates that are far from expiry', async () => {
    const h = await harness({ certExpiryWarnDays: 14 });
    await h.step({ ...UP, certExpiresAt: 1_000_000 + 90 * MS_PER_DAY });
    expect(h.received).toEqual([]);
  });

  it('does not resurrect a monitor deleted mid-check', async () => {
    const h = await harness({ failureThreshold: 1 });
    const storage = h.storage;
    const deps = {
      storage,
      dispatcher: new NotificationDispatcher({ storage, guard: openGuard }),
      logger: silentLogger,
      runner: async () => {
        await storage.deleteMonitor('monitor-1');
        return DOWN;
      },
      now: () => 5,
    };
    await processMonitor(h.monitor, deps);
    expect(await storage.listChecks('monitor-1')).toEqual([]);
    expect(await storage.listIncidents()).toEqual([]);
    expect(await storage.getState('monitor-1')).toBeUndefined();
  });
});
