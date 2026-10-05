import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { run } from '../src/cli/main.js';
import { closedPort, startHttp, tempDir } from './helpers.js';

const TOKEN = 'cli-test-token-0123456789-abcdef';

function cli(
  args: string[],
  env: Record<string, string> = {},
  waitForShutdown?: () => Promise<void>,
) {
  let stdout = '';
  let stderr = '';
  const code = run(args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    env,
    ...(waitForShutdown === undefined ? {} : { waitForShutdown }),
  });
  return code.then((exit) => ({ code: exit, stdout, stderr }));
}

describe('top level', () => {
  it('prints help and the version', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('server-monitor check');
    expect((await cli(['--version'])).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it('exits 2 without a command or with an unknown one', async () => {
    expect((await cli([])).code).toBe(2);
    const unknown = await cli(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command');
  });
});

describe('check', () => {
  it('reports UP with exit code 0', async () => {
    const server = await startHttp((_request, response) => response.end('ok'));
    const result = await cli(['check', server.url, '--allow-private']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^UP http:\/\/127\.0\.0\.1:\d+\/ \(\d+ ms\)\n$/);
  });

  it('reports DOWN with exit code 1 and supports --json', async () => {
    const server = await startHttp((_request, response) => {
      response.statusCode = 500;
      response.end();
    });
    const result = await cli(['check', server.url, '--allow-private', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      statusCode: 500,
      error: 'unexpected status 500',
    });
  });

  it('supports --expect, --keyword and --timeout', async () => {
    const server = await startHttp((_request, response) => {
      response.statusCode = 404;
      response.end('needle in haystack');
    });
    const ok = await cli([
      'check',
      server.url,
      '--allow-private',
      '--expect',
      '404',
      '-k',
      'needle',
    ]);
    expect(ok.code).toBe(0);
    const missing = await cli([
      'check',
      server.url,
      '--allow-private',
      '--expect',
      '400-499',
      '-k',
      'absent',
    ]);
    expect(missing.stdout).toContain('keyword not found');
    const slow = await startHttp(() => undefined);
    const timeout = await cli(['check', slow.url, '--allow-private', '--timeout', '500']);
    expect(timeout.stdout).toContain('timeout');
  });

  it('checks tcp targets', async () => {
    const port = await closedPort();
    const result = await cli(['check', `127.0.0.1:${port}`, '--type', 'tcp', '--allow-private']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('ECONNREFUSED');
  });

  it('blocks private targets unless --allow-private is given', async () => {
    const result = await cli(['check', 'http://169.254.169.254/']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not allowed');
  });

  it('does not print credentials or query strings from the target', async () => {
    const port = await closedPort();
    const result = await cli([
      'check',
      `http://127.0.0.1:${port}/path?token=SECRET`,
      '--allow-private',
    ]);
    expect(result.stdout).not.toContain('SECRET');
  });

  it.each([
    [['check']],
    [['check', 'a', 'b']],
    [['check', 'example.com']],
    [['check', 'http://example.com', '--expect', 'abc']],
    [['check', 'http://example.com', '--type', 'ftp']],
    [['check', 'http://example.com', '--timeout', 'soon']],
    [['check', 'http://example.com', '--bogus']],
  ])('exits 2 for invalid usage %j', async (args) => {
    expect((await cli(args)).code).toBe(2);
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ SERVER_MONITOR_TOKEN: TOKEN }, true)).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      storage: 'json',
      allowPrivateTargets: false,
      retentionDays: 30,
    });
  });

  it('requires a long token for the api only', () => {
    expect(() => loadConfig({}, true)).toThrow('SERVER_MONITOR_TOKEN');
    expect(() => loadConfig({ SERVER_MONITOR_TOKEN: 'short' }, true)).toThrow('at least');
    expect(() => loadConfig({}, false)).not.toThrow();
  });

  it.each([
    [{ SERVER_MONITOR_PORT: '0' }],
    [{ SERVER_MONITOR_PORT: '70000' }],
    [{ SERVER_MONITOR_PORT: 'abc' }],
    [{ SERVER_MONITOR_RETENTION_DAYS: '0' }],
    [{ SERVER_MONITOR_STORAGE: 'redis' }],
    [{ SERVER_MONITOR_STORAGE: 'postgres' }],
    [{ SERVER_MONITOR_ALLOW_PRIVATE_TARGETS: 'yes' }],
  ])('rejects invalid settings %j', (env) => {
    expect(() => loadConfig({ SERVER_MONITOR_TOKEN: TOKEN, ...env }, true)).toThrow();
  });

  it('parses explicit values', () => {
    const config = loadConfig(
      {
        SERVER_MONITOR_TOKEN: TOKEN,
        SERVER_MONITOR_STORAGE: 'postgres',
        PG_URL: 'postgres://u:p@h/db',
        SERVER_MONITOR_ALLOW_PRIVATE_TARGETS: 'true',
        SERVER_MONITOR_RETENTION_DAYS: '90',
      },
      true,
    );
    expect(config).toMatchObject({
      storage: 'postgres',
      allowPrivateTargets: true,
      retentionDays: 90,
    });
  });
});

describe('api and worker commands', () => {
  it('refuses to start the api without a token and does not echo env values', async () => {
    const result = await cli(['api'], { SERVER_MONITOR_TOKEN: 'short-secret' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('SERVER_MONITOR_TOKEN');
    expect(result.stderr).not.toContain('short-secret');
  });

  it('starts the api, serves requests and shuts down gracefully', async () => {
    const port = await closedPort();
    const dataFile = join(tempDir(), 'db.json');
    let shutdown: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      shutdown = resolve;
    });
    const running = cli(
      ['api'],
      {
        SERVER_MONITOR_TOKEN: TOKEN,
        SERVER_MONITOR_PORT: String(port),
        SERVER_MONITOR_DATA_FILE: dataFile,
      },
      () => stopped,
    );
    let response: Response | undefined;
    for (let attempt = 0; attempt < 50 && response === undefined; attempt++) {
      response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
      if (response === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(response?.status).toBe(200);
    shutdown();
    const result = await running;
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('api listening');
    expect(result.stderr).not.toContain(TOKEN);
  });

  it('starts the worker and stops it cleanly', async () => {
    const dataFile = join(tempDir(), 'db.json');
    const result = await cli(['worker'], { SERVER_MONITOR_DATA_FILE: dataFile }, () =>
      Promise.resolve(),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('worker started');
  });

  it('fails clearly when the port is already in use', async () => {
    const server = await startHttp((_request, response) => response.end());
    const result = await cli(
      ['api'],
      {
        SERVER_MONITOR_TOKEN: TOKEN,
        SERVER_MONITOR_PORT: String(server.port),
        SERVER_MONITOR_DATA_FILE: join(tempDir(), 'db.json'),
      },
      () => Promise.resolve(),
    );
    expect(result.code).toBe(2);
  });
});
