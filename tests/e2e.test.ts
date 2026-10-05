import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApiServer } from '../src/api/server.js';
import { silentLogger } from '../src/logger.js';
import { NotificationDispatcher } from '../src/notify/dispatcher.js';
import { JsonFileStorage } from '../src/storage/json-file.js';
import { defaultRunner, processMonitor } from '../src/worker/process-check.js';
import { openGuard, startHttp, tempDir } from './helpers.js';

const TOKEN = 'e2e-token-0123456789-abcdefghij';

it('api and worker cooperate through a shared JSON file', async () => {
  const file = join(tempDir(), 'shared.json');
  const target = await startHttp((_request, response) => {
    response.statusCode = target.requests.length > 3 ? 500 : 200;
    response.end('ok');
  });
  const apiStorage = new JsonFileStorage(file);
  const server = createApiServer({
    storage: apiStorage,
    guard: openGuard,
    token: TOKEN,
    logger: silentLogger,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const created = await fetch(`${base}/v1/monitors`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Target',
        type: 'http',
        target: target.url,
        failureThreshold: 2,
      }),
    });
    const { monitor } = (await created.json()) as { monitor: { id: string } };

    const workerStorage = new JsonFileStorage(file);
    const stored = await workerStorage.getMonitor(monitor.id);
    if (stored === undefined) throw new Error('monitor missing from shared storage');
    const deps = {
      storage: workerStorage,
      dispatcher: new NotificationDispatcher({ storage: workerStorage, guard: openGuard }),
      logger: silentLogger,
      runner: defaultRunner(openGuard),
      now: Date.now,
    };
    for (let round = 0; round < 6; round++) {
      await processMonitor(stored, deps);
    }

    const detail = (await (
      await fetch(`${base}/v1/monitors/${monitor.id}`, { headers })
    ).json()) as {
      state: { status: string; openIncidentId: string | null };
      stats: { uptime: Record<string, { uptimePercent: number | null }> };
    };
    expect(detail.state.status).toBe('down');
    expect(detail.state.openIncidentId).not.toBeNull();
    expect(detail.stats.uptime['24h']?.uptimePercent).not.toBeNull();

    const incidents = (await (
      await fetch(`${base}/v1/incidents?open=true`, { headers })
    ).json()) as {
      incidents: { cause: string; ongoing: boolean }[];
    };
    expect(incidents.incidents).toMatchObject([{ cause: 'unexpected status 500', ongoing: true }]);

    const history = (await (
      await fetch(`${base}/v1/monitors/${monitor.id}/checks?limit=10`, { headers })
    ).json()) as { checks: unknown[] };
    expect(history.checks).toHaveLength(6);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});
