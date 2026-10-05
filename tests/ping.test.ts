import { describe, expect, it } from 'vitest';
import { buildPingCommand, parsePingOutput } from '../src/core/ping-check.js';
import { runCheck } from '../src/core/run-check.js';
import { TargetGuard } from '../src/core/ssrf.js';
import { makeMonitor, openGuard } from './helpers.js';

const IPV4 = { address: '203.0.113.9', family: 4 } as const;
const IPV6 = { address: '2001:db8::1', family: 6 } as const;

describe('buildPingCommand', () => {
  it('uses millisecond timeouts and -n on Windows', () => {
    expect(buildPingCommand('win32', IPV4, 2500)).toEqual({
      command: 'ping',
      args: ['-n', '1', '-w', '2500', '203.0.113.9'],
    });
  });

  it('uses whole-second timeouts and -c on Linux', () => {
    expect(buildPingCommand('linux', IPV4, 2500)).toEqual({
      command: 'ping',
      args: ['-c', '1', '-W', '3', '203.0.113.9'],
    });
    expect(buildPingCommand('linux', IPV4, 100).args).toContain('1');
  });

  it('uses ping6 for IPv6 on macOS', () => {
    expect(buildPingCommand('darwin', IPV6, 1000).command).toBe('ping6');
    expect(buildPingCommand('darwin', IPV4, 1000).command).toBe('ping');
  });

  it('passes the address as a single argument without shell metacharacters', () => {
    const { args } = buildPingCommand('linux', IPV6, 1000);
    expect(args.at(-1)).toBe('2001:db8::1');
    expect(args).toHaveLength(5);
  });
});

describe('parsePingOutput', () => {
  it('parses Linux output', () => {
    const output =
      'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.\n64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=12.4 ms\n';
    expect(parsePingOutput(output)).toBe(12.4);
  });

  it('parses Windows output including sub-millisecond replies', () => {
    expect(parsePingOutput('Reply from 8.8.8.8: bytes=32 time=14ms TTL=117\r\n')).toBe(14);
    expect(parsePingOutput('Reply from 127.0.0.1: bytes=32 time<1ms TTL=128\r\n')).toBe(1);
  });

  it('parses comma decimal separators', () => {
    expect(parsePingOutput('64 bytes from ::1: icmp_seq=1 ttl=64 time=0,045 ms')).toBe(0.045);
  });

  it('ignores failures and unrelated lines', () => {
    expect(parsePingOutput('Request timed out.\r\nPacket loss 100%')).toBeNull();
    expect(parsePingOutput('Destination host unreachable. time=5ms')).toBeNull();
    expect(parsePingOutput('')).toBeNull();
  });
});

describe('ping check', () => {
  it('returns a structured outcome without throwing', async () => {
    const outcome = await runCheck(makeMonitor({ type: 'ping', target: '127.0.0.1' }), {
      guard: openGuard,
    });
    if (outcome.ok) {
      expect(outcome.responseTimeMs).toBeGreaterThanOrEqual(0);
    } else {
      expect(['ping command is not available', 'no ping reply', 'timeout']).toContain(
        outcome.error,
      );
    }
  });

  it('refuses private targets by default', async () => {
    const outcome = await runCheck(makeMonitor({ type: 'ping', target: '10.0.0.1' }), {
      guard: new TargetGuard(),
    });
    expect(outcome.error).toBe('target resolves to a blocked address');
  });
});
