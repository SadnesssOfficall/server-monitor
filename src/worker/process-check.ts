import { randomUUID } from 'node:crypto';
import {
  daysUntil,
  recordNotification,
  shouldNotify,
  type NotificationKind,
} from '../core/notify-policy.js';
import { runCheck } from '../core/run-check.js';
import { applyOutcome, initialState } from '../core/state-machine.js';
import type { TargetGuard } from '../core/ssrf.js';
import type { CheckOutcome, Incident, Monitor, MonitorState } from '../core/types.js';
import type { Logger } from '../logger.js';
import type { NotificationDispatcher } from '../notify/dispatcher.js';
import type { NotificationEvent } from '../notify/types.js';
import type { Storage } from '../storage/types.js';

export type CheckRunner = (monitor: Monitor) => Promise<CheckOutcome>;

export interface ProcessDeps {
  storage: Storage;
  dispatcher: NotificationDispatcher;
  logger: Logger;
  runner: CheckRunner;
  now: () => number;
}

export function defaultRunner(guard: TargetGuard, ca?: string | Buffer): CheckRunner {
  return (monitor) => runCheck(monitor, { guard, ...(ca === undefined ? {} : { ca }) });
}

function eventFor(
  kind: NotificationKind,
  monitor: Monitor,
  now: number,
  incident: Incident | null,
  certExpiresAt: number | null,
): NotificationEvent {
  return {
    kind,
    at: now,
    monitor: { id: monitor.id, name: monitor.name, type: monitor.type, target: monitor.target },
    incident:
      incident === null
        ? null
        : {
            id: incident.id,
            startedAt: incident.startedAt,
            resolvedAt: incident.resolvedAt,
            durationMs: (incident.resolvedAt ?? now) - incident.startedAt,
            cause: incident.cause,
          },
    certificate:
      kind === 'certificate_expiring' && certExpiresAt !== null
        ? { expiresAt: certExpiresAt, daysRemaining: daysUntil(certExpiresAt, now) }
        : null,
  };
}

async function notify(
  deps: ProcessDeps,
  monitor: Monitor,
  state: MonitorState,
  event: NotificationEvent,
): Promise<MonitorState> {
  if (!shouldNotify(event.kind, state, monitor, event.at)) return state;
  const results = await deps.dispatcher.dispatch(monitor, event);
  for (const result of results.filter((entry) => !entry.delivered)) {
    deps.logger.log('warn', 'notification failed', {
      monitorId: monitor.id,
      channelId: result.channelId,
      kind: event.kind,
      error: result.error,
    });
  }
  return recordNotification(state, event.kind, event.at);
}

export async function processMonitor(monitor: Monitor, deps: ProcessDeps): Promise<void> {
  const { storage } = deps;
  const outcome = await deps.runner(monitor);
  const now = deps.now();
  await storage.appendCheck({ ...outcome, monitorId: monitor.id, timestamp: now });
  const previous = (await storage.getState(monitor.id)) ?? initialState(monitor.id);
  const transition = applyOutcome(previous, outcome.ok, now, monitor);
  let state = transition.state;
  let incident: Incident | null = null;
  if (transition.change === 'incident_opened') {
    incident = {
      id: randomUUID(),
      monitorId: monitor.id,
      startedAt: transition.state.streakStartedAt ?? now,
      resolvedAt: null,
      cause: outcome.error ?? 'check failed',
    };
    await storage.saveIncident(incident);
    state = { ...state, openIncidentId: incident.id, streakStartedAt: null };
  } else if (transition.change === 'incident_resolved' && previous.openIncidentId !== null) {
    const open = await storage.getIncident(previous.openIncidentId);
    if (open !== undefined) {
      incident = { ...open, resolvedAt: now };
      await storage.saveIncident(incident);
    }
    state = { ...state, openIncidentId: null };
  }
  await storage.saveState(state);
  const saved = state;
  deps.logger.log('info', 'check completed', {
    monitorId: monitor.id,
    ok: outcome.ok,
    status: state.status,
    responseTimeMs: outcome.responseTimeMs,
    error: outcome.error,
  });
  if (transition.change !== null && incident !== null) {
    const kind = transition.change;
    state = await notify(deps, monitor, state, eventFor(kind, monitor, now, incident, null));
  }
  const expiresAt = outcome.certExpiresAt;
  if (outcome.ok && expiresAt !== null && daysUntil(expiresAt, now) <= monitor.certExpiryWarnDays) {
    state = await notify(
      deps,
      monitor,
      state,
      eventFor('certificate_expiring', monitor, now, null, expiresAt),
    );
  }
  if (state !== saved) await storage.saveState(state);
}
