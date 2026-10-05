import { computeResponseStats, computeUptime } from '../core/uptime.js';
import {
  MS_PER_DAY,
  MS_PER_SECOND,
  type CheckRecord,
  type Incident,
  type Monitor,
  type MonitorState,
} from '../core/types.js';
import type { Channel } from '../notify/types.js';

const MASK = '***';
const GAP_FACTOR = 2;
const WINDOWS = [
  { label: '24h', ms: MS_PER_DAY },
  { label: '7d', ms: 7 * MS_PER_DAY },
  { label: '30d', ms: 30 * MS_PER_DAY },
] as const;

export const STATS_HORIZON_MS = 30 * MS_PER_DAY;
export const RESPONSE_WINDOW_MS = MS_PER_DAY;

export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/${MASK}`;
  } catch {
    return MASK;
  }
}

function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  return at <= 0 ? MASK : `${address.slice(0, 1)}${MASK}${address.slice(at)}`;
}

export function viewChannel(channel: Channel): Record<string, unknown> {
  const common = {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    createdAt: channel.createdAt,
  };
  if (channel.type === 'email') {
    return {
      ...common,
      host: channel.host,
      port: channel.port,
      security: channel.security,
      from: maskEmail(channel.from),
      to: channel.to.map(maskEmail),
      authenticated: channel.username !== null,
    };
  }
  return { ...common, url: maskUrl(channel.url), signed: channel.type === 'webhook' };
}

export function viewIncident(incident: Incident, now: number): Record<string, unknown> {
  return {
    ...incident,
    ongoing: incident.resolvedAt === null,
    durationMs: (incident.resolvedAt ?? now) - incident.startedAt,
  };
}

export function viewState(state: MonitorState | undefined): Record<string, unknown> {
  return {
    status: state?.status ?? 'pending',
    lastCheckAt: state?.lastCheckAt ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    openIncidentId: state?.openIncidentId ?? null,
  };
}

export function computeStats(
  monitor: Monitor,
  checks: readonly CheckRecord[],
  now: number,
): Record<string, unknown> {
  const maxGapMs = monitor.intervalSeconds * MS_PER_SECOND * GAP_FACTOR + monitor.timeoutMs;
  const uptime = Object.fromEntries(
    WINDOWS.map(({ label, ms }) => {
      const result = computeUptime(checks, { from: now - ms, to: now }, maxGapMs);
      return [
        label,
        { uptimePercent: result.uptimePercent, downtimeMs: result.downMs, checks: result.checks },
      ];
    }),
  );
  const response = computeResponseStats(checks, { from: now - RESPONSE_WINDOW_MS, to: now });
  return { uptime, responseTime24h: response };
}
