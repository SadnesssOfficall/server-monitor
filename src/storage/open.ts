import type { Config } from '../config.js';
import { JsonFileStorage } from './json-file.js';
import { PostgresStorage } from './postgres.js';
import { createPgClient } from './sql-client.js';
import type { Storage } from './types.js';

export async function openStorage(config: Config): Promise<Storage> {
  if (config.storage === 'postgres' && config.pgUrl !== null) {
    return PostgresStorage.open(await createPgClient(config.pgUrl));
  }
  return new JsonFileStorage(config.dataFile);
}
