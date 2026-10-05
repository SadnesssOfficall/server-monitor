import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const IPV4_RANGES: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6_RANGES: readonly (readonly [string, number])[] = [
  ['::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const IPV6_GROUPS = 8;
const IPV6_MAPPED_PREFIX = 0xffff;
const NAT64_PREFIX = [0x64, 0xff9b];
const SIX_TO_FOUR_PREFIX = 0x2002;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const HEX_RADIX = 16;
const MAPPED_ZERO_GROUPS = 5;
const NAT64_ZERO_START = 2;

const ipv4Blocklist = new BlockList();
for (const [network, prefix] of IPV4_RANGES) ipv4Blocklist.addSubnet(network, prefix, 'ipv4');
const ipv6Blocklist = new BlockList();
for (const [network, prefix] of IPV6_RANGES) ipv6Blocklist.addSubnet(network, prefix, 'ipv6');

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function stripZone(address: string): string {
  const index = address.indexOf('%');
  return index === -1 ? address : address.slice(0, index);
}

function parseIPv6(address: string): number[] | null {
  let text = stripZone(address);
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.').map(Number);
    const [a, b, c, d] = octets;
    if (octets.length !== 4 || a === undefined || b === undefined) return null;
    if (c === undefined || d === undefined) return null;
    const high = ((a << BYTE_BITS) | b).toString(HEX_RADIX);
    const low = ((c << BYTE_BITS) | d).toString(HEX_RADIX);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const [head = '', rest, extra] = text.split('::');
  if (extra !== undefined) return null;
  const headGroups = head === '' ? [] : head.split(':');
  const restGroups = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = IPV6_GROUPS - headGroups.length - restGroups.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [
    ...headGroups,
    ...Array<string>(rest === undefined ? 0 : missing).fill('0'),
    ...restGroups,
  ];
  const values = groups.map((group) => Number.parseInt(group, HEX_RADIX));
  return values.length === IPV6_GROUPS && values.every((value) => Number.isInteger(value))
    ? values
    : null;
}

function embeddedIPv4(groups: readonly number[]): string | null {
  const toDotted = (high: number | undefined, low: number | undefined): string | null => {
    if (high === undefined || low === undefined) return null;
    return [high >> BYTE_BITS, high & BYTE_MASK, low >> BYTE_BITS, low & BYTE_MASK].join('.');
  };
  const leading = groups.slice(0, MAPPED_ZERO_GROUPS);
  if (leading.every((group) => group === 0) && groups[MAPPED_ZERO_GROUPS] === IPV6_MAPPED_PREFIX) {
    return toDotted(groups[6], groups[7]);
  }
  const nat64Zeros = groups.slice(NAT64_ZERO_START, 6);
  if (
    groups[0] === NAT64_PREFIX[0] &&
    groups[1] === NAT64_PREFIX[1] &&
    nat64Zeros.every((group) => group === 0)
  ) {
    return toDotted(groups[6], groups[7]);
  }
  return groups[0] === SIX_TO_FOUR_PREFIX ? toDotted(groups[1], groups[2]) : null;
}

export function isPrivateAddress(address: string): boolean {
  const bare = stripBrackets(stripZone(address));
  const family = isIP(bare);
  if (family === 4) return ipv4Blocklist.check(bare, 'ipv4');
  if (family !== 6) return true;
  const groups = parseIPv6(bare);
  if (groups === null) return true;
  const embedded = embeddedIPv4(groups);
  if (embedded !== null) return ipv4Blocklist.check(embedded, 'ipv4');
  const canonical = groups.map((group) => group.toString(HEX_RADIX)).join(':');
  return ipv6Blocklist.check(canonical, 'ipv6');
}

export class BlockedTargetError extends Error {
  constructor() {
    super('target resolves to a blocked address');
    this.name = 'BlockedTargetError';
  }
}

export class ResolutionError extends Error {
  constructor() {
    super('dns: no addresses found');
    this.name = 'ResolutionError';
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

export interface TargetGuardOptions {
  allowPrivateTargets?: boolean;
  resolver?: Resolver;
  isBlocked?: (address: string) => boolean;
}

export class TargetGuard {
  private readonly allowPrivate: boolean;
  private readonly resolver: Resolver;
  private readonly isBlocked: (address: string) => boolean;

  constructor(options: TargetGuardOptions = {}) {
    this.allowPrivate = options.allowPrivateTargets ?? false;
    this.resolver = options.resolver ?? systemResolver;
    this.isBlocked = options.isBlocked ?? isPrivateAddress;
  }

  isBlockedLiteral(host: string): boolean {
    if (this.allowPrivate) return false;
    const bare = stripBrackets(host).toLowerCase();
    if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
    return isIP(stripZone(bare)) !== 0 && this.isBlocked(bare);
  }

  async resolve(host: string): Promise<ResolvedTarget> {
    if (this.isBlockedLiteral(host)) throw new BlockedTargetError();
    const bare = stripBrackets(host);
    const candidates = isIP(bare) === 0 ? await this.resolver(bare) : [bare];
    const [address] = candidates;
    if (address === undefined) throw new ResolutionError();
    if (!this.allowPrivate && candidates.some((candidate) => this.isBlocked(candidate))) {
      throw new BlockedTargetError();
    }
    const family = isIP(address);
    if (family !== 4 && family !== 6) throw new ResolutionError();
    return { address, family };
  }
}

export function pinnedLookup(target: ResolvedTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
}
