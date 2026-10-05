import { parseArgs } from 'node:util';
import { runCheck } from '../core/run-check.js';
import { TargetGuard } from '../core/ssrf.js';
import { redactTarget } from '../core/target.js';
import { MONITOR_TYPES, type MonitorType } from '../core/types.js';
import { ValidationError } from '../validation/fields.js';
import { validateMonitorInput } from '../validation/monitor.js';
import type { CliIo } from './main.js';

export const EXIT_UP = 0;
export const EXIT_DOWN = 1;
export const EXIT_USAGE = 2;

const STATUS_PATTERN = /^(\d{3})(?:-(\d{3}))?$/;

function inferType(target: string): MonitorType | null {
  if (target.startsWith('https://')) return 'https';
  return target.startsWith('http://') ? 'http' : null;
}

export async function checkCommand(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      type: { type: 'string', short: 't' },
      timeout: { type: 'string' },
      expect: { type: 'string' },
      keyword: { type: 'string', short: 'k' },
      redirects: { type: 'string' },
      'allow-private': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const [target, extra] = positionals;
  if (target === undefined || extra !== undefined) {
    io.stderr.write('usage: server-monitor check <target> [options]\n');
    return EXIT_USAGE;
  }
  const type = values.type ?? (values.keyword === undefined ? inferType(target) : 'keyword');
  if (type === null || !MONITOR_TYPES.some((known) => known === type)) {
    io.stderr.write(`error: --type must be one of ${MONITOR_TYPES.join(', ')}\n`);
    return EXIT_USAGE;
  }
  const range = values.expect === undefined ? null : STATUS_PATTERN.exec(values.expect);
  if (values.expect !== undefined && range === null) {
    io.stderr.write('error: --expect must look like 200 or 200-299\n');
    return EXIT_USAGE;
  }
  const guard = new TargetGuard({ allowPrivateTargets: values['allow-private'] === true });
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout);
  const redirects = values.redirects === undefined ? undefined : Number(values.redirects);
  try {
    const monitor = validateMonitorInput(
      {
        name: 'cli',
        type,
        target,
        ...(values.keyword === undefined ? {} : { keyword: values.keyword }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(redirects === undefined ? {} : { maxRedirects: redirects }),
        ...(range === null
          ? {}
          : { expectedStatus: { min: Number(range[1]), max: Number(range[2] ?? range[1]) } }),
        intervalSeconds: 86_400,
      },
      { guard, now: Date.now() },
    );
    const outcome = await runCheck(monitor, { guard });
    if (values.json === true) {
      io.stdout.write(`${JSON.stringify({ target: redactTarget(target), type, ...outcome })}\n`);
    } else {
      const label = outcome.ok ? 'UP' : 'DOWN';
      const detail = outcome.ok ? `${outcome.responseTimeMs ?? 0} ms` : (outcome.error ?? 'failed');
      io.stdout.write(`${label} ${redactTarget(target)} (${detail})\n`);
    }
    return outcome.ok ? EXIT_UP : EXIT_DOWN;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    for (const issue of error.issues) io.stderr.write(`error: ${issue.field} ${issue.message}\n`);
    return EXIT_USAGE;
  }
}
