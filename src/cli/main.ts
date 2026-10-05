import { readFileSync } from 'node:fs';
import { ConfigError, loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { checkCommand, EXIT_USAGE } from './check-command.js';
import { startApi, startWorker, type RunningService } from './services.js';

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  waitForShutdown?: () => Promise<void>;
}

const HELP = `server-monitor - uptime monitoring

Usage:
  server-monitor api                 Start the REST API
  server-monitor worker              Start the check worker
  server-monitor check <target> [options]
                                     Run a single check and exit

Check options:
  -t, --type <type>      http, https, tcp, ping or keyword (default: from the URL)
  -k, --keyword <text>   Require this text in the response body
      --expect <range>   Accepted status code or range, e.g. 200 or 200-299
      --timeout <ms>     Timeout in milliseconds
      --redirects <n>    Maximum redirects to follow
      --allow-private    Allow private, loopback and link-local targets
      --json             Print the result as JSON

Environment:
  SERVER_MONITOR_TOKEN, SERVER_MONITOR_HOST, SERVER_MONITOR_PORT,
  SERVER_MONITOR_STORAGE, SERVER_MONITOR_DATA_FILE, PG_URL,
  SERVER_MONITOR_ALLOW_PRIVATE_TARGETS, SERVER_MONITOR_RETENTION_DAYS

Options:
  -h, --help       Show this help
  -v, --version    Show the version
`;

function version(): string {
  const manifest = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function signalShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

async function serve(
  start: (
    config: ReturnType<typeof loadConfig>,
    logger: ReturnType<typeof createLogger>,
  ) => Promise<RunningService>,
  requireToken: boolean,
  io: CliIo,
): Promise<number> {
  const config = loadConfig(io.env, requireToken);
  const service = await start(
    config,
    createLogger((line) => io.stderr.write(line)),
  );
  await (io.waitForShutdown ?? signalShutdown)();
  await service.stop();
  return 0;
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined) {
      io.stderr.write(HELP);
      return EXIT_USAGE;
    }
    if (command === '-h' || command === '--help') {
      io.stdout.write(HELP);
      return 0;
    }
    if (command === '-v' || command === '--version') {
      io.stdout.write(`${version()}\n`);
      return 0;
    }
    if (command === 'check') return await checkCommand(rest, io);
    if (command === 'api') return await serve(startApi, true, io);
    if (command === 'worker') return await serve(startWorker, false, io);
    io.stderr.write(`error: unknown command "${command}"\n\n${HELP}`);
    return EXIT_USAGE;
  } catch (error) {
    const message =
      error instanceof ConfigError || error instanceof TypeError
        ? error.message
        : (errorCode(error) ?? 'unexpected error');
    io.stderr.write(`error: ${message}\n`);
    return EXIT_USAGE;
  }
}
