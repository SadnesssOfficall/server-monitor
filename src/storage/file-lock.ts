import { mkdir, rmdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const STALE_LOCK_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 15_000;
const RETRY_BASE_MS = 10;
const RETRY_JITTER_MS = 20;

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function removeIfStale(lockPath: string): Promise<void> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs > STALE_LOCK_MS) await rmdir(lockPath);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
}

async function acquire(lockPath: string): Promise<void> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for the storage file lock');
    await removeIfStale(lockPath);
    await delay(RETRY_BASE_MS + Math.random() * RETRY_JITTER_MS);
  }
}

export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await acquire(lockPath);
  try {
    return await operation();
  } finally {
    await rmdir(lockPath).catch(() => undefined);
  }
}
