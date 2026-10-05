import type { Server } from 'node:http';
import { createApiServer } from '../api/server.js';
import type { Config } from '../config.js';
import { TargetGuard } from '../core/ssrf.js';
import type { Logger } from '../logger.js';
import { NotificationDispatcher } from '../notify/dispatcher.js';
import { openStorage } from '../storage/open.js';
import { defaultRunner, processMonitor } from '../worker/process-check.js';
import { Scheduler } from '../worker/scheduler.js';

export interface RunningService {
  stop(): Promise<void>;
}

export async function startApi(config: Config, logger: Logger): Promise<RunningService> {
  const storage = await openStorage(config);
  const guard = new TargetGuard({ allowPrivateTargets: config.allowPrivateTargets });
  const server: Server = createApiServer({ storage, guard, token: config.token, logger });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  logger.log('info', 'api listening', { host: config.host, port: config.port });
  return {
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeIdleConnections();
      });
      await storage.close();
    },
  };
}

export async function startWorker(config: Config, logger: Logger): Promise<RunningService> {
  const storage = await openStorage(config);
  const guard = new TargetGuard({ allowPrivateTargets: config.allowPrivateTargets });
  const dispatcher = new NotificationDispatcher({ storage, guard });
  const deps = { storage, dispatcher, logger, runner: defaultRunner(guard), now: Date.now };
  const scheduler = new Scheduler({
    storage,
    logger,
    retentionDays: config.retentionDays,
    process: (monitor) => processMonitor(monitor, deps),
  });
  scheduler.start();
  logger.log('info', 'worker started', { retentionDays: config.retentionDays });
  return {
    stop: async () => {
      await scheduler.stop();
      await storage.close();
    },
  };
}
