import { MS_PER_DAY, MS_PER_HOUR, MS_PER_SECOND, type Monitor } from '../core/types.js';
import type { Logger } from '../logger.js';
import type { Storage } from '../storage/types.js';

export interface SchedulerOptions {
  storage: Storage;
  process: (monitor: Monitor) => Promise<void>;
  logger: Logger;
  retentionDays: number;
  now?: () => number;
  random?: () => number;
  tickMs?: number;
  maxConcurrent?: number;
}

interface Slot {
  dueAt: number;
  updatedAt: number;
}

const DEFAULT_TICK_MS = 1000;
const DEFAULT_MAX_CONCURRENT = 20;
const JITTER_RATIO = 0.1;
const MAX_STARTUP_SPREAD_MS = 10 * MS_PER_SECOND;
const PRUNE_INTERVAL_MS = MS_PER_HOUR;

export class Scheduler {
  private readonly slots = new Map<string, Slot>();
  private readonly running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastPrune = -Infinity;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.timer !== null || this.stopping) return;
    const tick = (): void => {
      this.tick().catch((error: unknown) => {
        this.options.logger.log('error', 'scheduler tick failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      });
    };
    this.timer = setInterval(tick, this.options.tickMs ?? DEFAULT_TICK_MS);
    tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(this.running.values());
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    await this.pruneIfDue(now);
    const monitors = await this.options.storage.listMonitors();
    const active = new Set(monitors.map((monitor) => monitor.id));
    for (const id of this.slots.keys()) if (!active.has(id)) this.slots.delete(id);
    const limit = this.options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    for (const monitor of monitors) {
      if (!monitor.enabled) {
        this.slots.delete(monitor.id);
        continue;
      }
      if (this.running.size >= limit) break;
      if (this.isDue(monitor, now)) this.launch(monitor);
    }
  }

  private isDue(monitor: Monitor, now: number): boolean {
    if (this.running.has(monitor.id)) return false;
    const slot = this.slots.get(monitor.id);
    if (slot === undefined || slot.updatedAt !== monitor.updatedAt) {
      const spread = Math.min(monitor.intervalSeconds * MS_PER_SECOND, MAX_STARTUP_SPREAD_MS);
      this.slots.set(monitor.id, {
        dueAt: now + this.random() * spread,
        updatedAt: monitor.updatedAt,
      });
      return false;
    }
    return slot.dueAt <= now;
  }

  private launch(monitor: Monitor): void {
    const interval = monitor.intervalSeconds * MS_PER_SECOND;
    const jitter = (this.random() * 2 - 1) * interval * JITTER_RATIO;
    this.slots.set(monitor.id, {
      dueAt: this.now() + interval + jitter,
      updatedAt: monitor.updatedAt,
    });
    const run = this.options
      .process(monitor)
      .catch((error: unknown) => {
        this.options.logger.log('error', 'check processing failed', {
          monitorId: monitor.id,
          error: error instanceof Error ? error.name : 'unknown',
        });
      })
      .finally(() => {
        this.running.delete(monitor.id);
      });
    this.running.set(monitor.id, run);
  }

  private async pruneIfDue(now: number): Promise<void> {
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    const removed = await this.options.storage.prune(now - this.options.retentionDays * MS_PER_DAY);
    if (removed.checks > 0 || removed.incidents > 0) {
      this.options.logger.log('info', 'retention cleanup', { ...removed });
    }
  }
}
