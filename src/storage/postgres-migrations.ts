import type { SqlClient } from './sql-client.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_LOCK_KEY = 727_274_001;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_states (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors (id) ON DELETE CASCADE,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  id BIGSERIAL PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  checked_at BIGINT NOT NULL,
  ok BOOLEAN NOT NULL,
  response_time_ms DOUBLE PRECISION,
  status_code INTEGER,
  error TEXT,
  cert_expires_at BIGINT
);
CREATE INDEX IF NOT EXISTS checks_monitor_time ON checks (monitor_id, checked_at);
CREATE INDEX IF NOT EXISTS checks_time ON checks (checked_at);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  started_at BIGINT NOT NULL,
  resolved_at BIGINT,
  cause TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_monitor_started ON incidents (monitor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS incidents_resolved ON incidents (resolved_at);
`,
  },
];

export async function migrate(client: SqlClient, now: () => number = Date.now): Promise<void> {
  await client.query(`
SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY});
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at BIGINT NOT NULL
);
`);
  const applied = await client.query('SELECT version FROM schema_migrations');
  const known = new Set(applied.rows.map((row) => Number(row.version)));
  for (const migration of MIGRATIONS) {
    if (known.has(migration.version)) continue;
    const name = migration.name.replaceAll("'", "''");
    await client.query(`
SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY});
${migration.sql}
INSERT INTO schema_migrations (version, name, applied_at)
VALUES (${migration.version}, '${name}', ${now()})
ON CONFLICT (version) DO NOTHING;
`);
  }
}
