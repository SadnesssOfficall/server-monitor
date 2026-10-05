import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/core/run-check.js';
import {
  BlockedTargetError,
  isPrivateAddress,
  pinnedLookup,
  ResolutionError,
  TargetGuard,
} from '../src/core/ssrf.js';
import { makeMonitor, openGuard, startHttp } from './helpers.js';

const PRIVATE = [
  '127.0.0.1',
  '127.1.2.3',
  '10.0.0.1',
  '172.16.5.4',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254',
  '169.254.0.1',
  '100.64.0.1',
  '0.0.0.0',
  '224.0.0.1',
  '255.255.255.255',
  '::1',
  '::',
  'fe80::1',
  'fe80::1%eth0',
  'fc00::1',
  'fd12:3456::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:169.254.169.254',
  '64:ff9b::a00:1',
  '2002:a00:1::1',
  '[::1]',
  'not-an-ip',
];
const PUBLIC = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111'];

describe('isPrivateAddress', () => {
  it.each(PRIVATE)('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(PUBLIC)('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('TargetGuard', () => {
  it('blocks localhost names and private literals before any lookup', async () => {
    const guard = new TargetGuard({
      resolver: () => Promise.reject(new Error('resolver must not be called')),
    });
    for (const host of [
      'localhost',
      'LOCALHOST',
      'api.localhost',
      '127.0.0.1',
      '[::1]',
      '10.1.1.1',
    ]) {
      await expect(guard.resolve(host)).rejects.toBeInstanceOf(BlockedTargetError);
    }
  });

  it('blocks a hostname that resolves to a private address', async () => {
    const guard = new TargetGuard({ resolver: () => Promise.resolve(['10.0.0.8']) });
    await expect(guard.resolve('internal.example')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('blocks when any resolved address is private', async () => {
    const guard = new TargetGuard({
      resolver: () => Promise.resolve(['93.184.216.34', '169.254.169.254']),
    });
    await expect(guard.resolve('mixed.example')).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('allows public addresses and returns the address family', async () => {
    const guard = new TargetGuard({ resolver: () => Promise.resolve(['2606:4700:4700::1111']) });
    await expect(guard.resolve('v6.example')).resolves.toEqual({
      address: '2606:4700:4700::1111',
      family: 6,
    });
  });

  it('fails clearly when DNS returns nothing', async () => {
    const guard = new TargetGuard({ resolver: () => Promise.resolve([]) });
    await expect(guard.resolve('empty.example')).rejects.toBeInstanceOf(ResolutionError);
  });

  it('allows private targets only when explicitly enabled', async () => {
    await expect(openGuard.resolve('127.0.0.1')).resolves.toEqual({
      address: '127.0.0.1',
      family: 4,
    });
  });

  it('exposes literal checks for validation', () => {
    const guard = new TargetGuard();
    expect(guard.isBlockedLiteral('169.254.169.254')).toBe(true);
    expect(guard.isBlockedLiteral('example.com')).toBe(false);
    expect(openGuard.isBlockedLiteral('169.254.169.254')).toBe(false);
  });
});

describe('pinnedLookup', () => {
  it('always answers with the validated address', () => {
    const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 });
    lookup('anything.example', {}, (error, address, family) => {
      expect([error, address, family]).toEqual([null, '93.184.216.34', 4]);
    });
    lookup('anything.example', { all: true }, (_error, addresses) => {
      expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });
  });
});

describe('checks against blocked targets', () => {
  const targets = [
    'http://127.0.0.1:1/',
    'http://localhost/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://10.0.0.5/admin',
  ];

  it.each(targets)('refuses %s by default', async (target) => {
    const outcome = await runCheck(makeMonitor({ target }), { guard: new TargetGuard() });
    expect(outcome).toMatchObject({
      ok: false,
      error: 'target resolves to a blocked address',
    });
  });

  it('refuses tcp and ping targets in private ranges', async () => {
    const guard = new TargetGuard();
    for (const type of ['tcp', 'ping'] as const) {
      const target = type === 'tcp' ? '192.168.0.1:22' : '192.168.0.1';
      const outcome = await runCheck(makeMonitor({ type, target }), { guard });
      expect(outcome.error).toBe('target resolves to a blocked address');
    }
  });

  it('never contacts the server when the target is blocked', async () => {
    const server = await startHttp((_request, response) => response.end('ok'));
    const outcome = await runCheck(makeMonitor({ target: server.url }), {
      guard: new TargetGuard(),
    });
    expect(outcome.ok).toBe(false);
    expect(server.requests).toEqual([]);
  });

  it('monitors loopback once allowPrivateTargets is on', async () => {
    const server = await startHttp((_request, response) => response.end('ok'));
    const outcome = await runCheck(makeMonitor({ target: server.url }), { guard: openGuard });
    expect(outcome.ok).toBe(true);
  });
});

describe('DNS rebinding', () => {
  it('connects to the validated address and resolves the name exactly once', async () => {
    const server = await startHttp((_request, response) => response.end('ok'));
    const answers = [['127.0.0.1'], ['169.254.169.254']];
    let lookups = 0;
    const guard = new TargetGuard({
      resolver: () => Promise.resolve(answers[Math.min(lookups++, answers.length - 1)] ?? []),
      isBlocked: (address) => address !== '127.0.0.1',
    });
    const outcome = await runCheck(
      makeMonitor({ target: `http://rebind.example:${server.port}/` }),
      { guard },
    );
    expect(outcome.ok).toBe(true);
    expect(lookups).toBe(1);
    expect(server.requests).toEqual(['GET /']);
  });

  it('rejects a name whose first answer is internal', async () => {
    const guard = new TargetGuard({ resolver: () => Promise.resolve(['169.254.169.254']) });
    const outcome = await runCheck(makeMonitor({ target: 'http://rebind.example/' }), { guard });
    expect(outcome.error).toBe('target resolves to a blocked address');
  });
});

describe('redirect escape', () => {
  const guardAllowingOnlyLoopbackAsPublic = (): TargetGuard =>
    new TargetGuard({
      resolver: () => Promise.resolve(['127.0.0.1']),
      isBlocked: (address) => address !== '127.0.0.1' && isPrivateAddress(address),
    });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://localhost/',
  ])('re-validates the redirect target %s', async (location) => {
    const server = await startHttp((_request, response) => {
      response.writeHead(302, { Location: location });
      response.end();
    });
    const outcome = await runCheck(
      makeMonitor({ target: `http://public.example:${server.port}/`, maxRedirects: 5 }),
      { guard: guardAllowingOnlyLoopbackAsPublic() },
    );
    expect(outcome).toMatchObject({ ok: false, error: 'target resolves to a blocked address' });
    expect(server.requests).toHaveLength(1);
  });

  it('re-validates after a multi-hop chain', async () => {
    const server = await startHttp((request, response) => {
      const next = request.url === '/' ? '/second' : 'http://192.168.1.1/';
      response.writeHead(301, { Location: next });
      response.end();
    });
    const outcome = await runCheck(
      makeMonitor({ target: `http://public.example:${server.port}/` }),
      { guard: guardAllowingOnlyLoopbackAsPublic() },
    );
    expect(outcome.error).toBe('target resolves to a blocked address');
    expect(server.requests).toEqual(['GET /', 'GET /second']);
  });

  it('rejects redirects to non-http protocols', async () => {
    const server = await startHttp((_request, response) => {
      response.writeHead(302, { Location: 'file:///etc/passwd' });
      response.end();
    });
    const outcome = await runCheck(makeMonitor({ target: server.url }), { guard: openGuard });
    expect(outcome).toMatchObject({ ok: false, error: 'unsupported redirect protocol' });
  });
});
