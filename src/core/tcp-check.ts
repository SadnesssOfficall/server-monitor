import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { abortable } from './deadline.js';
import { failure, success, type CheckContext } from './outcome.js';
import { parseHostPort } from './target.js';
import type { CheckOutcome, Monitor } from './types.js';

export async function checkTcp(monitor: Monitor, context: CheckContext): Promise<CheckOutcome> {
  const parsed = parseHostPort(monitor.target);
  if (parsed === null) return failure('invalid target');
  const started = performance.now();
  const resolved = await abortable(context.guard.resolve(parsed.host), context.signal);
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({
      host: resolved.address,
      port: parsed.port,
      signal: context.signal,
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
  return success({ responseTimeMs: Math.round(performance.now() - started) });
}
