import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '../core/types.js';
import type { NotificationEvent } from './types.js';

export interface EventDescription {
  title: string;
  lines: string[];
  severity: 'critical' | 'resolved' | 'warning';
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND)) * MS_PER_SECOND;
  const days = Math.floor(total / MS_PER_DAY);
  const hours = Math.floor((total % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((total % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = (total % MS_PER_MINUTE) / MS_PER_SECOND;
  const parts = [
    days > 0 ? `${days}d` : '',
    hours > 0 ? `${hours}h` : '',
    minutes > 0 ? `${minutes}m` : '',
    seconds > 0 || total === 0 ? `${seconds}s` : '',
  ];
  return parts.filter((part) => part !== '').join(' ');
}

export function describeEvent(event: NotificationEvent): EventDescription {
  const { monitor, incident, certificate } = event;
  const base = [`Monitor: ${monitor.name}`, `Target: ${monitor.target}`];
  if (event.kind === 'incident_opened' && incident !== null) {
    return {
      title: `DOWN: ${monitor.name}`,
      severity: 'critical',
      lines: [
        ...base,
        `Cause: ${incident.cause}`,
        `Started: ${new Date(incident.startedAt).toISOString()}`,
      ],
    };
  }
  if (event.kind === 'incident_resolved' && incident !== null) {
    return {
      title: `RECOVERED: ${monitor.name}`,
      severity: 'resolved',
      lines: [...base, `Downtime: ${formatDuration(incident.durationMs)}`],
    };
  }
  return {
    title: `CERTIFICATE EXPIRING: ${monitor.name}`,
    severity: 'warning',
    lines: [
      ...base,
      `Expires: ${new Date(certificate?.expiresAt ?? event.at).toISOString()}`,
      `Days remaining: ${certificate?.daysRemaining ?? 0}`,
    ],
  };
}
