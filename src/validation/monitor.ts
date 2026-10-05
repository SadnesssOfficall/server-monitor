import { randomUUID } from 'node:crypto';
import type { TargetGuard } from '../core/ssrf.js';
import { isValidHost, parseHostPort } from '../core/target.js';
import {
  KEYWORD_MODES,
  MONITOR_TYPES,
  MS_PER_SECOND,
  type Monitor,
  type MonitorType,
  type StatusRange,
} from '../core/types.js';
import { Collector, isRecord, ValidationError, type Raw } from './fields.js';
import { ID_PATTERN, LIMITS } from './limits.js';

export const EDITABLE_MONITOR_FIELDS = [
  'name',
  'type',
  'target',
  'enabled',
  'intervalSeconds',
  'timeoutMs',
  'expectedStatus',
  'maxRedirects',
  'failureThreshold',
  'recoveryThreshold',
  'keyword',
  'keywordMode',
  'maxBodyBytes',
  'certExpiryWarnDays',
  'notificationCooldownSeconds',
  'channelIds',
] as const;

const DEFAULT_STATUS: StatusRange = { min: 200, max: 299 };

export interface MonitorValidationOptions {
  guard: TargetGuard;
  now: number;
  existing?: Monitor;
}

function allowedProtocols(type: MonitorType): string[] {
  if (type === 'http') return ['http:'];
  return type === 'https' ? ['https:'] : ['http:', 'https:'];
}

function checkUrlTarget(type: MonitorType, target: string, guard: TargetGuard, c: Collector): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    c.add('target', 'must be a valid URL');
    return;
  }
  const allowed = allowedProtocols(type);
  if (!allowed.includes(url.protocol)) {
    c.add('target', `protocol must be ${allowed.map((value) => value.slice(0, -1)).join(' or ')}`);
  } else if (url.username !== '' || url.password !== '') {
    c.add('target', 'must not contain credentials');
  } else if (guard.isBlockedLiteral(url.hostname)) {
    c.add('target', 'host is not allowed; enable allowPrivateTargets to monitor private addresses');
  }
}

function checkTarget(type: MonitorType, target: string, guard: TargetGuard, c: Collector): void {
  if (type === 'tcp') {
    const parsed = parseHostPort(target);
    if (parsed === null) c.add('target', 'must be host:port');
    else if (guard.isBlockedLiteral(parsed.host)) c.add('target', 'host is not allowed');
  } else if (type === 'ping') {
    if (!isValidHost(target)) c.add('target', 'must be a hostname or IP address');
    else if (guard.isBlockedLiteral(target)) c.add('target', 'host is not allowed');
  } else {
    checkUrlTarget(type, target, guard, c);
  }
}

function readStatus(raw: Raw, c: Collector): StatusRange {
  const value = raw.expectedStatus;
  if (value === undefined) return DEFAULT_STATUS;
  if (!isRecord(value)) {
    c.add('expectedStatus', 'must be an object with min and max');
    return DEFAULT_STATUS;
  }
  const range = { min: LIMITS.status.min, max: LIMITS.status.max };
  const min = c.integer(value, 'min', range, DEFAULT_STATUS.min);
  const max = c.integer(value, 'max', range, DEFAULT_STATUS.max);
  if (min > max) c.add('expectedStatus', 'min must not exceed max');
  return { min, max };
}

function fromExisting(existing: Monitor): Raw {
  return Object.fromEntries(EDITABLE_MONITOR_FIELDS.map((key) => [key, existing[key]]));
}

export function validateMonitorInput(input: unknown, options: MonitorValidationOptions): Monitor {
  if (!isRecord(input)) {
    throw new ValidationError([{ field: 'body', message: 'must be an object' }]);
  }
  const raw: Raw = options.existing ? { ...fromExisting(options.existing), ...input } : input;
  const c = new Collector();
  c.rejectUnknown(input, EDITABLE_MONITOR_FIELDS);
  const name = c.text(raw, 'name', LIMITS.name.max, true);
  const type = c.choice(raw, 'type', MONITOR_TYPES);
  const target = c.text(raw, 'target', LIMITS.target.max, true);
  const intervalSeconds = c.integer(
    raw,
    'intervalSeconds',
    LIMITS.interval,
    LIMITS.interval.fallback,
  );
  const timeoutMs = c.integer(raw, 'timeoutMs', LIMITS.timeout, LIMITS.timeout.fallback);
  if (timeoutMs >= intervalSeconds * MS_PER_SECOND) {
    c.add('timeoutMs', 'must be shorter than the interval');
  }
  const keyword = raw.keyword === null ? null : c.text(raw, 'keyword', LIMITS.keyword.max, false);
  if (type === 'keyword' && keyword === null) c.add('keyword', 'is required for keyword monitors');
  if (type !== null && target !== null) checkTarget(type, target, options.guard, c);
  const monitor: Monitor = {
    id: options.existing?.id ?? randomUUID(),
    name: name ?? '',
    type: type ?? 'http',
    target: target ?? '',
    enabled: c.boolean(raw, 'enabled', true),
    intervalSeconds,
    timeoutMs,
    expectedStatus: readStatus(raw, c),
    maxRedirects: c.integer(raw, 'maxRedirects', LIMITS.redirects, LIMITS.redirects.fallback),
    failureThreshold: c.integer(
      raw,
      'failureThreshold',
      LIMITS.failureThreshold,
      LIMITS.failureThreshold.fallback,
    ),
    recoveryThreshold: c.integer(
      raw,
      'recoveryThreshold',
      LIMITS.recoveryThreshold,
      LIMITS.recoveryThreshold.fallback,
    ),
    keyword,
    keywordMode: c.choice(raw, 'keywordMode', KEYWORD_MODES, 'present') ?? 'present',
    maxBodyBytes: c.integer(raw, 'maxBodyBytes', LIMITS.bodyBytes, LIMITS.bodyBytes.fallback),
    certExpiryWarnDays: c.integer(
      raw,
      'certExpiryWarnDays',
      LIMITS.certWarnDays,
      LIMITS.certWarnDays.fallback,
    ),
    notificationCooldownSeconds: c.integer(
      raw,
      'notificationCooldownSeconds',
      LIMITS.cooldown,
      LIMITS.cooldown.fallback,
    ),
    channelIds: c.stringList(raw, 'channelIds', LIMITS.channelIds.max, (id) => ID_PATTERN.test(id)),
    createdAt: options.existing?.createdAt ?? options.now,
    updatedAt: options.now,
  };
  c.finish();
  return monitor;
}
