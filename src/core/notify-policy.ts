import { MS_PER_DAY, MS_PER_SECOND, type Monitor, type MonitorState } from './types.js';

export const NOTIFICATION_KINDS = [
  'incident_opened',
  'incident_resolved',
  'certificate_expiring',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const CERTIFICATE_COOLDOWN_MS = MS_PER_DAY;

export function shouldNotify(
  kind: NotificationKind,
  state: MonitorState,
  monitor: Pick<Monitor, 'notificationCooldownSeconds'>,
  now: number,
): boolean {
  if (kind === 'incident_resolved') return state.incidentNotified;
  const last = state.lastNotified[kind];
  const cooldownMs =
    kind === 'incident_opened'
      ? monitor.notificationCooldownSeconds * MS_PER_SECOND
      : CERTIFICATE_COOLDOWN_MS;
  return last === undefined || now - last >= cooldownMs;
}

export function recordNotification(
  state: MonitorState,
  kind: NotificationKind,
  now: number,
): MonitorState {
  if (kind === 'incident_resolved') return { ...state, incidentNotified: false };
  return {
    ...state,
    incidentNotified: kind === 'incident_opened' ? true : state.incidentNotified,
    lastNotified: { ...state.lastNotified, [kind]: now },
  };
}

export function daysUntil(expiresAt: number, now: number): number {
  return Math.floor((expiresAt - now) / MS_PER_DAY);
}
