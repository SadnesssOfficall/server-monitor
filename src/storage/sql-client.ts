export interface SqlResult {
  rows: Record<string, unknown>[];
}

export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<SqlResult>;
  end(): Promise<void>;
}

interface PgPool {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: { connectionString: string; max: number }) => PgPool;
}

const POOL_SIZE = 5;

function isPgModule(value: unknown): value is PgModule {
  if (typeof value !== 'object' || value === null) return false;
  const pool: unknown = 'Pool' in value ? value.Pool : undefined;
  return typeof pool === 'function';
}

export async function createPgClient(connectionString: string): Promise<SqlClient> {
  const moduleName = 'pg';
  let loaded: unknown;
  try {
    loaded = await import(moduleName);
  } catch {
    throw new Error('the "pg" package is required for PostgreSQL storage; run: npm install pg');
  }
  const exported: unknown =
    typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : loaded;
  if (!isPgModule(exported)) throw new Error('the installed "pg" package is not compatible');
  const pool = new exported.Pool({ connectionString, max: POOL_SIZE });
  return {
    query: async (text, params) => {
      const result = await pool.query(text, params);
      return { rows: result.rows };
    },
    end: () => pool.end(),
  };
}
