import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { MS_PER_DAY } from '../src/core/types.js';
import type { CheckRecord, Incident, Monitor } from '../src/core/types.js';
import type { Channel } from '../src/notify/types.js';
import { JsonFileStorage } from '../src/storage/json-file.js';
import { MemoryStorage } from '../src/storage/memory.js';
import { migrate, MIGRATIONS } from '../src/storage/postgres-migrations.js';
import { PostgresStorage } from '../src/storage/postgres.js';
import { createPgClient, type SqlClient } from '../src/storage/sql-client.js';
import type { Storage } from '../src/storage/types.js';
import { makeMonitor, tempDir } from './helpers.js';

function pgliteClient(db: PGlite): SqlClient {
  return {
    query: async (text, params) => {
      if (params === undefined || params.length === 0) {
        const results = await db.exec(text);
        return { rows: results.at(-1)?.rows ?? [] };
      }
      const result = await db.query(text, [...params]);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    end: () => db.close(),
  };
}

const channel: Channel = {
  id: 'channel-1',
  name: 'Hook',
  type: 'webhook',
  url: 'https://example.com/hook',
  secret: 'a-very-long-secret-value',
  createdAt: 1,
};

const check = (timestamp: number, ok = true, monitorId = 'monitor-1'): CheckRecord => ({
  monitorId,
  timestamp,
  ok,
  responseTimeMs: ok ? 12.5 : null,
  statusCode: ok ? 200 : null,
  error: ok ? null : 'timeout',
  certExpiresAt: ok ? 5 : null,
});

const incident = (id: string, startedAt: number, resolvedAt: number | null): Incident => ({
  id,
  monitorId: 'monitor-1',
  startedAt,
  resolvedAt,
  cause: 'timeout',
});

type Factory = () => Promise<Storage>;

function contract(name: string, create: Factory): void {
  describe(`${name} storage`, () => {
    const withMonitor = async (): Promise<Storage> => {
      const storage = await create();
      await storage.saveMonitor(makeMonitor());
      return storage;
    };

    it('round-trips monitors', async () => {
      const storage = await create();
      const monitor: Monitor = makeMonitor({ channelIds: ['channel-1'], keyword: 'ok' });
      await storage.saveMonitor(monitor);
      expect(await storage.getMonitor('monitor-1')).toEqual(monitor);
      expect(await storage.listMonitors()).toEqual([monitor]);
      expect(await storage.getMonitor('missing')).toBeUndefined();
      await storage.saveMonitor({ ...monitor, name: 'Renamed' });
      expect((await storage.listMonitors()).map((entry) => entry.name)).toEqual(['Renamed']);
      await storage.close();
    });

    it('round-trips channels and deletes them', async () => {
      const storage = await create();
      await storage.saveChannel(channel);
      expect(await storage.getChannel('channel-1')).toEqual(channel);
      expect(await storage.deleteChannel('channel-1')).toBe(true);
      expect(await storage.deleteChannel('channel-1')).toBe(false);
      expect(await storage.listChannels()).toEqual([]);
      await storage.close();
    });

    it('stores and filters checks', async () => {
      const storage = await withMonitor();
      for (const timestamp of [3000, 1000, 2000]) await storage.appendCheck(check(timestamp));
      expect((await storage.listChecks('monitor-1')).map((entry) => entry.timestamp)).toEqual([
        1000, 2000, 3000,
      ]);
      expect(
        (await storage.listChecks('monitor-1', { since: 2000, newestFirst: true })).map(
          (entry) => entry.timestamp,
        ),
      ).toEqual([3000, 2000]);
      expect(await storage.listChecks('monitor-1', { until: 1500 })).toHaveLength(1);
      expect(await storage.listChecks('monitor-1', { limit: 2 })).toHaveLength(2);
      expect(await storage.listChecks('monitor-1')).toContainEqual(check(1000));
      await storage.close();
    });

    it('ignores checks for unknown monitors', async () => {
      const storage = await create();
      await storage.appendCheck(check(1000, true, 'ghost'));
      expect(await storage.listChecks('ghost')).toEqual([]);
      await storage.close();
    });

    it('stores incidents and filters them', async () => {
      const storage = await withMonitor();
      await storage.saveIncident(incident('a', 1000, 2000));
      await storage.saveIncident(incident('b', 3000, null));
      expect((await storage.listIncidents()).map((entry) => entry.id)).toEqual(['b', 'a']);
      expect((await storage.listIncidents({ openOnly: true })).map((entry) => entry.id)).toEqual([
        'b',
      ]);
      expect(await storage.listIncidents({ monitorId: 'other' })).toEqual([]);
      expect(await storage.listIncidents({ limit: 1 })).toHaveLength(1);
      await storage.saveIncident(incident('b', 3000, 4000));
      expect(await storage.getIncident('b')).toEqual(incident('b', 3000, 4000));
      await storage.close();
    });

    it('stores monitor state', async () => {
      const storage = await withMonitor();
      const state = {
        monitorId: 'monitor-1',
        status: 'down' as const,
        consecutiveFailures: 3,
        consecutiveSuccesses: 0,
        streakStartedAt: 1000,
        lastCheckAt: 4000,
        openIncidentId: 'a',
        incidentNotified: true,
        lastNotified: { incident_opened: 4000 },
      };
      await storage.saveState(state);
      expect(await storage.getState('monitor-1')).toEqual(state);
      await storage.close();
    });

    it('cascades monitor deletion', async () => {
      const storage = await withMonitor();
      await storage.appendCheck(check(1000));
      await storage.saveIncident(incident('a', 1000, null));
      expect(await storage.deleteMonitor('monitor-1')).toBe(true);
      expect(await storage.listChecks('monitor-1')).toEqual([]);
      expect(await storage.listIncidents()).toEqual([]);
      expect(await storage.getState('monitor-1')).toBeUndefined();
      expect(await storage.deleteMonitor('monitor-1')).toBe(false);
      await storage.close();
    });

    it('prunes old checks and resolved incidents but keeps open incidents', async () => {
      const storage = await withMonitor();
      const now = 100 * MS_PER_DAY;
      await storage.appendCheck(check(now - 40 * MS_PER_DAY));
      await storage.appendCheck(check(now - 1 * MS_PER_DAY));
      await storage.saveIncident(incident('old', now - 41 * MS_PER_DAY, now - 40 * MS_PER_DAY));
      await storage.saveIncident(incident('open', now - 50 * MS_PER_DAY, null));
      await storage.saveIncident(incident('recent', now - 2 * MS_PER_DAY, now - MS_PER_DAY));
      const removed = await storage.prune(now - 30 * MS_PER_DAY);
      expect(removed).toEqual({ checks: 1, incidents: 1 });
      expect(await storage.listChecks('monitor-1')).toHaveLength(1);
      expect((await storage.listIncidents()).map((entry) => entry.id).sort()).toEqual([
        'open',
        'recent',
      ]);
      await storage.close();
    });

    it('returns copies, not live references', async () => {
      const storage = await withMonitor();
      const monitor = await storage.getMonitor('monitor-1');
      if (monitor) monitor.name = 'mutated';
      expect((await storage.getMonitor('monitor-1'))?.name).toBe('Example');
      await storage.close();
    });
  });
}

contract('memory', () => Promise.resolve(new MemoryStorage()));
contract('json file', () => Promise.resolve(new JsonFileStorage(join(tempDir(), 'db.json'))));
contract('postgres (in-process PGlite)', async () =>
  PostgresStorage.open(pgliteClient(new PGlite())),
);

describe('json file storage', () => {
  it('persists across instances and creates missing directories', async () => {
    const path = join(tempDir(), 'nested', 'db.json');
    const first = new JsonFileStorage(path);
    await first.saveMonitor(makeMonitor());
    await first.appendCheck(check(1000));
    await first.close();
    const second = new JsonFileStorage(path);
    expect(await second.listMonitors()).toHaveLength(1);
    expect(await second.listChecks('monitor-1')).toHaveLength(1);
  });

  it('lets two instances write concurrently without losing updates', async () => {
    const path = join(tempDir(), 'db.json');
    const writer = new JsonFileStorage(path);
    const other = new JsonFileStorage(path);
    await writer.saveMonitor(makeMonitor());
    const total = 25;
    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        (index % 2 === 0 ? writer : other).appendCheck(check(1000 + index)),
      ),
    );
    expect(await new JsonFileStorage(path).listChecks('monitor-1')).toHaveLength(total);
  });

  it('lets a reader see another instance’s later writes', async () => {
    const path = join(tempDir(), 'db.json');
    const reader = new JsonFileStorage(path);
    const writer = new JsonFileStorage(path);
    expect(await reader.listMonitors()).toEqual([]);
    await writer.saveMonitor(makeMonitor());
    expect(await reader.listMonitors()).toHaveLength(1);
  });

  it('refuses a corrupt file instead of overwriting it', async () => {
    const directory = tempDir();
    const path = join(directory, 'db.json');
    writeFileSync(path, '{not json');
    const storage = new JsonFileStorage(path);
    await expect(storage.listMonitors()).rejects.toThrow('not valid JSON');
    await expect(storage.saveMonitor(makeMonitor())).rejects.toThrow('not valid JSON');
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });

  it('rejects a file with an unexpected structure', async () => {
    const directory = tempDir();
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'db.json');
    writeFileSync(path, '[1,2,3]');
    await expect(new JsonFileStorage(path).listMonitors()).rejects.toThrow('unexpected structure');
  });

  it('does not leave temporary or lock files behind', async () => {
    const directory = tempDir();
    const storage = new JsonFileStorage(join(directory, 'db.json'));
    await storage.saveMonitor(makeMonitor());
    await storage.close();
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(directory)).toEqual(['db.json']);
  });
});

describe('postgres migrations', () => {
  it('is idempotent and records applied versions', async () => {
    const db = new PGlite();
    const client = pgliteClient(db);
    await migrate(client, () => 1234);
    await migrate(client, () => 9999);
    const result = await client.query('SELECT version, applied_at FROM schema_migrations');
    expect(result.rows).toHaveLength(MIGRATIONS.length);
    expect(Number(result.rows[0]?.applied_at)).toBe(1234);
  });

  it('uses parameters rather than string concatenation for values', async () => {
    const storage = await PostgresStorage.open(pgliteClient(new PGlite()));
    const hostile = makeMonitor({ name: "x'); DROP TABLE monitors;--" });
    await storage.saveMonitor(hostile);
    expect((await storage.listMonitors())[0]?.name).toBe(hostile.name);
    await storage.appendCheck({ ...check(1), error: "'; DROP TABLE checks;--" });
    expect(await storage.listChecks('monitor-1')).toHaveLength(1);
  });
});

describe.runIf(process.env.PG_URL !== undefined)('postgres (PG_URL)', () => {
  it('runs migrations and basic operations against a real server', async () => {
    const client = await createPgClient(process.env.PG_URL ?? '');
    const storage = await PostgresStorage.open(client);
    const id = `it-${Date.now()}`;
    await storage.saveMonitor(makeMonitor({ id }));
    await storage.appendCheck(check(1000, true, id));
    expect(await storage.listChecks(id)).toHaveLength(1);
    expect(await storage.deleteMonitor(id)).toBe(true);
    await storage.close();
  });
});
