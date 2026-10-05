export type StorageKind = 'json' | 'postgres';

export interface Config {
  token: string;
  host: string;
  port: number;
  storage: StorageKind;
  dataFile: string;
  pgUrl: string | null;
  allowPrivateTargets: boolean;
  retentionDays: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_PORT = 8080;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const MAX_PORT = 65_535;
export const MIN_TOKEN_LENGTH = 24;

function parseInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseBoolean(env: Record<string, string | undefined>, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new ConfigError(`${name} must be "true" or "false"`);
}

export function loadConfig(env: Record<string, string | undefined>, requireToken: boolean): Config {
  const token = env.SERVER_MONITOR_TOKEN ?? '';
  if (requireToken && token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `SERVER_MONITOR_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  const storage = env.SERVER_MONITOR_STORAGE ?? 'json';
  if (storage !== 'json' && storage !== 'postgres') {
    throw new ConfigError('SERVER_MONITOR_STORAGE must be "json" or "postgres"');
  }
  const pgUrl = env.PG_URL ?? null;
  if (storage === 'postgres' && (pgUrl === null || pgUrl === '')) {
    throw new ConfigError('PG_URL is required when SERVER_MONITOR_STORAGE is "postgres"');
  }
  return {
    token,
    host: env.SERVER_MONITOR_HOST ?? '127.0.0.1',
    port: parseInteger(env, 'SERVER_MONITOR_PORT', DEFAULT_PORT, 1, MAX_PORT),
    storage,
    dataFile: env.SERVER_MONITOR_DATA_FILE ?? './data/server-monitor.json',
    pgUrl,
    allowPrivateTargets: parseBoolean(env, 'SERVER_MONITOR_ALLOW_PRIVATE_TARGETS'),
    retentionDays: parseInteger(
      env,
      'SERVER_MONITOR_RETENTION_DAYS',
      DEFAULT_RETENTION_DAYS,
      1,
      MAX_RETENTION_DAYS,
    ),
  };
}
