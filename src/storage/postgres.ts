import type { Channel } from '../notify/types.js';
import type { CheckRecord, Incident, Monitor, MonitorState } from '../core/types.js';
import { migrate } from './postgres-migrations.js';
import type { SqlClient } from './sql-client.js';
import type { CheckQuery, IncidentQuery, PruneResult, Storage } from './types.js';

type Row = Record<string, unknown>;

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function toCheck(row: Row): CheckRecord {
  return {
    monitorId: String(row.monitor_id),
    timestamp: toNumber(row.checked_at),
    ok: row.ok === true,
    responseTimeMs: toNullableNumber(row.response_time_ms),
    statusCode: toNullableNumber(row.status_code),
    error: typeof row.error === 'string' ? row.error : null,
    certExpiresAt: toNullableNumber(row.cert_expires_at),
  };
}

function toIncident(row: Row): Incident {
  return {
    id: String(row.id),
    monitorId: String(row.monitor_id),
    startedAt: toNumber(row.started_at),
    resolvedAt: toNullableNumber(row.resolved_at),
    cause: String(row.cause),
  };
}

export class PostgresStorage implements Storage {
  private constructor(private readonly client: SqlClient) {}

  static async open(client: SqlClient): Promise<PostgresStorage> {
    await migrate(client);
    return new PostgresStorage(client);
  }

  private async documents<T>(table: 'monitors' | 'channels'): Promise<T[]> {
    const result = await this.client.query(`SELECT data FROM ${table} ORDER BY id`);
    return result.rows.map((row) => parseJson(row.data) as T);
  }

  private async document<T>(
    table: 'monitors' | 'channels' | 'monitor_states',
    key: 'id' | 'monitor_id',
    id: string,
  ): Promise<T | undefined> {
    const result = await this.client.query(`SELECT data FROM ${table} WHERE ${key} = $1`, [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : (parseJson(row.data) as T);
  }

  private async upsert(table: 'monitors' | 'channels', id: string, data: unknown): Promise<void> {
    await this.client.query(
      `INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [id, JSON.stringify(data)],
    );
  }

  private async remove(table: 'monitors' | 'channels', id: string): Promise<boolean> {
    const result = await this.client.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]);
    return result.rows.length > 0;
  }

  listMonitors(): Promise<Monitor[]> {
    return this.documents<Monitor>('monitors');
  }

  getMonitor(id: string): Promise<Monitor | undefined> {
    return this.document<Monitor>('monitors', 'id', id);
  }

  saveMonitor(monitor: Monitor): Promise<void> {
    return this.upsert('monitors', monitor.id, monitor);
  }

  deleteMonitor(id: string): Promise<boolean> {
    return this.remove('monitors', id);
  }

  listChannels(): Promise<Channel[]> {
    return this.documents<Channel>('channels');
  }

  getChannel(id: string): Promise<Channel | undefined> {
    return this.document<Channel>('channels', 'id', id);
  }

  saveChannel(channel: Channel): Promise<void> {
    return this.upsert('channels', channel.id, channel);
  }

  deleteChannel(id: string): Promise<boolean> {
    return this.remove('channels', id);
  }

  async appendCheck(record: CheckRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO checks
         (monitor_id, checked_at, ok, response_time_ms, status_code, error, cert_expires_at)
       SELECT $1::text, $2::bigint, $3::boolean, $4::double precision, $5::integer, $6::text, $7::bigint
       WHERE EXISTS (SELECT 1 FROM monitors WHERE id = $1::text)`,
      [
        record.monitorId,
        record.timestamp,
        record.ok,
        record.responseTimeMs,
        record.statusCode,
        record.error,
        record.certExpiresAt,
      ],
    );
  }

  async listChecks(monitorId: string, query: CheckQuery = {}): Promise<CheckRecord[]> {
    const params: unknown[] = [monitorId];
    const conditions = ['monitor_id = $1'];
    if (query.since !== undefined) {
      params.push(query.since);
      conditions.push(`checked_at >= $${params.length}`);
    }
    if (query.until !== undefined) {
      params.push(query.until);
      conditions.push(`checked_at <= $${params.length}`);
    }
    let sql = `SELECT * FROM checks WHERE ${conditions.join(' AND ')}
               ORDER BY checked_at ${query.newestFirst === true ? 'DESC' : 'ASC'}, id`;
    if (query.limit !== undefined) {
      params.push(query.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const result = await this.client.query(sql, params);
    return result.rows.map(toCheck);
  }

  getState(monitorId: string): Promise<MonitorState | undefined> {
    return this.document<MonitorState>('monitor_states', 'monitor_id', monitorId);
  }

  async saveState(state: MonitorState): Promise<void> {
    await this.client.query(
      `INSERT INTO monitor_states (monitor_id, data)
       SELECT $1::text, $2::jsonb WHERE EXISTS (SELECT 1 FROM monitors WHERE id = $1::text)
       ON CONFLICT (monitor_id) DO UPDATE SET data = EXCLUDED.data`,
      [state.monitorId, JSON.stringify(state)],
    );
  }

  async getIncident(id: string): Promise<Incident | undefined> {
    const result = await this.client.query('SELECT * FROM incidents WHERE id = $1', [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : toIncident(row);
  }

  async saveIncident(incident: Incident): Promise<void> {
    await this.client.query(
      `INSERT INTO incidents (id, monitor_id, started_at, resolved_at, cause)
       SELECT $1::text, $2::text, $3::bigint, $4::bigint, $5::text
       WHERE EXISTS (SELECT 1 FROM monitors WHERE id = $2::text)
       ON CONFLICT (id) DO UPDATE SET resolved_at = EXCLUDED.resolved_at, cause = EXCLUDED.cause`,
      [incident.id, incident.monitorId, incident.startedAt, incident.resolvedAt, incident.cause],
    );
  }

  async listIncidents(query: IncidentQuery = {}): Promise<Incident[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (query.monitorId !== undefined) {
      params.push(query.monitorId);
      conditions.push(`monitor_id = $${params.length}`);
    }
    if (query.openOnly === true) conditions.push('resolved_at IS NULL');
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    let sql = `SELECT * FROM incidents ${where} ORDER BY started_at DESC, id`;
    if (query.limit !== undefined) {
      params.push(query.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const result = await this.client.query(sql, params);
    return result.rows.map(toIncident);
  }

  async prune(olderThan: number): Promise<PruneResult> {
    const count = async (sql: string): Promise<number> => {
      const result = await this.client.query(sql, [olderThan]);
      return toNumber(result.rows[0]?.count ?? 0);
    };
    const checks = await count(
      'WITH removed AS (DELETE FROM checks WHERE checked_at < $1 RETURNING 1) SELECT count(*) AS count FROM removed',
    );
    const incidents = await count(
      'WITH removed AS (DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < $1 RETURNING 1) SELECT count(*) AS count FROM removed',
    );
    return { checks, incidents };
  }

  close(): Promise<void> {
    return this.client.end();
  }
}
