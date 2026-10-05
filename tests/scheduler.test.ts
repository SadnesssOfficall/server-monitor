import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, type CheckOutcome, type Monitor } from '../src/core/types.js';
import { silentLogger } from '../src/logger.js';
import { MemoryStorage } from '../src/storage/memory.js';
import { Scheduler } from '../src/worker/scheduler.js';
import { makeMonitor } from './helpers.js';

const UP: CheckOutcome = {
  ok: true,
  responseTimeMs: 20,
  statusCode: 200,
  error: null,
  certExpiresAt: null,
};

describe('Scheduler', () => {
  const deferred = () => {
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  async function setup(monitors: Monitor[], process: (monitor: Monitor) => Promise<void>) {
    const storage = new MemoryStorage();
    for (const monitor of monitors) await storage.saveMonitor(monitor);
    let clock = 0;
    const scheduler = new Scheduler({
      storage,
      process,
      logger: silentLogger,
      retentionDays: 30,
      now: () => clock,
      random: () => 0.5,
      maxConcurrent: 2,
    });
    return {
      storage,
      scheduler,
      advance: async (ms: number) => {
        clock += ms;
        await scheduler.tick();
      },
    };
  }

  it('spreads the first run, then repeats at the interval with jitter', async () => {
    const runs: number[] = [];
    let clock = 0;
    let random = 0.5;
    const storage = new MemoryStorage();
    await storage.saveMonitor(makeMonitor({ intervalSeconds: 60 }));
    const scheduler = new Scheduler({
      storage,
      process: () => {
        runs.push(clock);
        return Promise.resolve();
      },
      logger: silentLogger,
      retentionDays: 30,
      now: () => clock,
      random: () => random,
    });
    const tickAt = async (time: number): Promise<void> => {
      clock = time;
      await scheduler.tick();
    };
    await tickAt(0);
    await tickAt(4999);
    expect(runs).toEqual([]);
    random = 1;
    await tickAt(5000);
    expect(runs).toEqual([5000]);
    await tickAt(5000 + 66_000 - 1);
    expect(runs).toEqual([5000]);
    await tickAt(5000 + 66_000);
    expect(runs).toEqual([5000, 71_000]);
    await scheduler.stop();
  });

  it('does not run a monitor again while the previous check is in flight', async () => {
    const gate = deferred();
    let calls = 0;
    const { scheduler, advance } = await setup([makeMonitor({ intervalSeconds: 10 })], () => {
      calls += 1;
      return gate.promise;
    });
    await advance(0);
    await advance(10_000);
    await advance(10_000);
    expect(calls).toBe(1);
    await advance(60_000);
    expect(calls).toBe(1);
    gate.release();
    await scheduler.stop();
    expect(calls).toBe(1);
  });

  it('runs due monitors, skips disabled ones and honours the concurrency limit', async () => {
    const started: string[] = [];
    const gate = deferred();
    const monitors = ['a', 'b', 'c'].map((id) => makeMonitor({ id, intervalSeconds: 10 }));
    monitors.push(makeMonitor({ id: 'off', enabled: false, intervalSeconds: 10 }));
    const { scheduler, advance } = await setup(monitors, (monitor) => {
      started.push(monitor.id);
      return gate.promise;
    });
    await advance(0);
    await advance(10_000);
    expect(started).toHaveLength(2);
    expect(started).not.toContain('off');
    gate.release();
    await scheduler.stop();
  });

  it('keeps going when a check processor throws', async () => {
    let calls = 0;
    const { scheduler, advance } = await setup([makeMonitor({ intervalSeconds: 10 })], () => {
      calls += 1;
      return Promise.reject(new Error('boom'));
    });
    await advance(0);
    await advance(11_000);
    await Promise.resolve();
    await advance(30_000);
    await scheduler.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('waits for in-flight checks on stop and then ignores further ticks', async () => {
    const gate = deferred();
    let finished = false;
    let started = 0;
    const { scheduler, advance } = await setup([makeMonitor({ intervalSeconds: 10 })], async () => {
      started += 1;
      await gate.promise;
      finished = true;
    });
    await advance(0);
    await advance(10_000);
    const stopping = scheduler.stop();
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.release();
    await stopping;
    expect(finished).toBe(true);
    await advance(1_000_000);
    expect(started).toBe(1);
  });

  it('applies retention by pruning old data on the first tick', async () => {
    const storage = new MemoryStorage();
    await storage.saveMonitor(makeMonitor());
    const now = 100 * MS_PER_DAY;
    await storage.appendCheck({ ...UP, monitorId: 'monitor-1', timestamp: now - 31 * MS_PER_DAY });
    await storage.appendCheck({ ...UP, monitorId: 'monitor-1', timestamp: now - MS_PER_DAY });
    const scheduler = new Scheduler({
      storage,
      process: () => Promise.resolve(),
      logger: silentLogger,
      retentionDays: 30,
      now: () => now,
    });
    await scheduler.tick();
    expect(await storage.listChecks('monitor-1')).toHaveLength(1);
    await scheduler.stop();
  });

  it('reschedules a monitor when it is edited', async () => {
    let calls = 0;
    const storage = new MemoryStorage();
    const monitor = makeMonitor({ intervalSeconds: 3600 });
    await storage.saveMonitor(monitor);
    let clock = 0;
    const scheduler = new Scheduler({
      storage,
      process: () => {
        calls += 1;
        return Promise.resolve();
      },
      logger: silentLogger,
      retentionDays: 30,
      now: () => clock,
      random: () => 0,
    });
    await scheduler.tick();
    clock = 1;
    await scheduler.tick();
    expect(calls).toBe(1);
    await storage.saveMonitor({ ...monitor, intervalSeconds: 10, updatedAt: 5 });
    clock = 2;
    await scheduler.tick();
    clock = 3;
    await scheduler.tick();
    await scheduler.stop();
    expect(calls).toBe(2);
  });
});
