import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Channel } from '../notify/types.js';
import type { CheckRecord, Incident, Monitor, MonitorState } from '../core/types.js';
import { withFileLock } from './file-lock.js';
import { MemoryStorage, emptyDataset, type Dataset } from './memory.js';
import type { CheckQuery, IncidentQuery, PruneResult, Storage } from './types.js';

const FILE_MODE = 0o600;
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isDatasetShape(value: unknown): value is Partial<Dataset> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class JsonFileStorage implements Storage {
  private readonly lockPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private cache: { key: string; data: Dataset } | undefined;

  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
  }

  private async load(): Promise<Dataset> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyDataset();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('storage file is not valid JSON');
    }
    if (!isDatasetShape(parsed)) throw new Error('storage file has an unexpected structure');
    return { ...emptyDataset(), ...parsed };
  }

  private async persist(data: Dataset): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: FILE_MODE });
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(temporary, this.path);
        return;
      } catch (error) {
        const transient = TRANSIENT_RENAME_CODES.has(errorCode(error) ?? '');
        if (!transient || attempt >= RENAME_ATTEMPTS) throw error;
        await delay(RENAME_RETRY_MS * attempt);
      }
    }
  }

  private async read<T>(operation: (store: MemoryStorage) => Promise<T>): Promise<T> {
    let key = 'missing';
    try {
      const info = await stat(this.path);
      key = `${info.mtimeMs}:${info.size}:${info.ino}`;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    if (this.cache?.key !== key) this.cache = { key, data: await this.load() };
    return operation(new MemoryStorage(this.cache.data));
  }

  private write<T>(operation: (store: MemoryStorage) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await mkdir(dirname(this.path), { recursive: true });
      return withFileLock(this.lockPath, async () => {
        const store = new MemoryStorage(await this.load());
        const result = await operation(store);
        await this.persist(store.data);
        return result;
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  listMonitors(): Promise<Monitor[]> {
    return this.read((store) => store.listMonitors());
  }

  getMonitor(id: string): Promise<Monitor | undefined> {
    return this.read((store) => store.getMonitor(id));
  }

  saveMonitor(monitor: Monitor): Promise<void> {
    return this.write((store) => store.saveMonitor(monitor));
  }

  deleteMonitor(id: string): Promise<boolean> {
    return this.write((store) => store.deleteMonitor(id));
  }

  listChannels(): Promise<Channel[]> {
    return this.read((store) => store.listChannels());
  }

  getChannel(id: string): Promise<Channel | undefined> {
    return this.read((store) => store.getChannel(id));
  }

  saveChannel(channel: Channel): Promise<void> {
    return this.write((store) => store.saveChannel(channel));
  }

  deleteChannel(id: string): Promise<boolean> {
    return this.write((store) => store.deleteChannel(id));
  }

  appendCheck(record: CheckRecord): Promise<void> {
    return this.write((store) => store.appendCheck(record));
  }

  listChecks(monitorId: string, query?: CheckQuery): Promise<CheckRecord[]> {
    return this.read((store) => store.listChecks(monitorId, query));
  }

  getState(monitorId: string): Promise<MonitorState | undefined> {
    return this.read((store) => store.getState(monitorId));
  }

  saveState(state: MonitorState): Promise<void> {
    return this.write((store) => store.saveState(state));
  }

  getIncident(id: string): Promise<Incident | undefined> {
    return this.read((store) => store.getIncident(id));
  }

  saveIncident(incident: Incident): Promise<void> {
    return this.write((store) => store.saveIncident(incident));
  }

  listIncidents(query?: IncidentQuery): Promise<Incident[]> {
    return this.read((store) => store.listIncidents(query));
  }

  prune(olderThan: number): Promise<PruneResult> {
    return this.write((store) => store.prune(olderThan));
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
