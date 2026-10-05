import { execFile } from 'node:child_process';
import { abortable, TimeoutError } from './deadline.js';
import { failure, success, type CheckContext } from './outcome.js';
import type { ResolvedTarget } from './ssrf.js';
import type { CheckOutcome, Monitor } from './types.js';

const MS_PER_SECOND = 1000;
const MAX_PING_OUTPUT_BYTES = 64 * 1024;
const REPLY_MARKER = /\bttl[=:]/i;
const REPLY_TIME = /[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i;

export class PingUnavailableError extends Error {
  constructor() {
    super('ping command is not available');
    this.name = 'PingUnavailableError';
  }
}

export interface PingCommand {
  command: string;
  args: string[];
}

export function buildPingCommand(
  platform: NodeJS.Platform,
  target: ResolvedTarget,
  timeoutMs: number,
): PingCommand {
  const seconds = Math.max(1, Math.ceil(timeoutMs / MS_PER_SECOND));
  if (platform === 'win32') {
    return { command: 'ping', args: ['-n', '1', '-w', String(timeoutMs), target.address] };
  }
  if (platform === 'darwin') {
    return {
      command: target.family === 6 ? 'ping6' : 'ping',
      args: ['-c', '1', '-W', String(timeoutMs), target.address],
    };
  }
  return { command: 'ping', args: ['-c', '1', '-W', String(seconds), target.address] };
}

export function parsePingOutput(output: string): number | null {
  for (const line of output.split(/\r?\n/)) {
    if (!REPLY_MARKER.test(line)) continue;
    const match = REPLY_TIME.exec(line);
    const raw = match?.[1];
    if (raw !== undefined) return Number(raw.replace(',', '.'));
  }
  return null;
}

function run(command: PingCommand, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command.command,
      command.args,
      { signal, windowsHide: true, maxBuffer: MAX_PING_OUTPUT_BYTES },
      (error, stdout) => {
        if (error?.code === 'ENOENT') {
          reject(new PingUnavailableError());
        } else if (signal.aborted) {
          reject(new TimeoutError());
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export async function checkPing(monitor: Monitor, context: CheckContext): Promise<CheckOutcome> {
  const resolved = await abortable(context.guard.resolve(monitor.target), context.signal);
  const output = await run(
    buildPingCommand(process.platform, resolved, monitor.timeoutMs),
    context.signal,
  );
  const reported = parsePingOutput(output);
  if (reported === null) return failure('no ping reply');
  return success({ responseTimeMs: Math.round(reported) });
}
