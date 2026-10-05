import type { MonitorState } from './types.js';

export type StateChange = 'incident_opened' | 'incident_resolved' | null;

export interface Thresholds {
  failureThreshold: number;
  recoveryThreshold: number;
}

export interface Transition {
  state: MonitorState;
  change: StateChange;
}

export function initialState(monitorId: string): MonitorState {
  return {
    monitorId,
    status: 'pending',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    streakStartedAt: null,
    lastCheckAt: null,
    openIncidentId: null,
    incidentNotified: false,
    lastNotified: {},
  };
}

function afterSuccess(state: MonitorState, now: number, thresholds: Thresholds): Transition {
  const successes = state.consecutiveSuccesses + 1;
  const base = { ...state, consecutiveFailures: 0, consecutiveSuccesses: successes };
  if (state.status !== 'down') {
    return {
      state: { ...base, status: 'up', streakStartedAt: null, lastCheckAt: now },
      change: null,
    };
  }
  if (successes >= thresholds.recoveryThreshold) {
    return {
      state: { ...base, status: 'up', streakStartedAt: null, lastCheckAt: now },
      change: 'incident_resolved',
    };
  }
  return { state: { ...base, lastCheckAt: now }, change: null };
}

function afterFailure(state: MonitorState, now: number, thresholds: Thresholds): Transition {
  const failures = state.consecutiveFailures + 1;
  const base = {
    ...state,
    consecutiveFailures: failures,
    consecutiveSuccesses: 0,
    lastCheckAt: now,
  };
  if (state.status === 'down') return { state: base, change: null };
  const streakStartedAt = state.consecutiveFailures === 0 ? now : (state.streakStartedAt ?? now);
  if (failures >= thresholds.failureThreshold) {
    return { state: { ...base, status: 'down', streakStartedAt }, change: 'incident_opened' };
  }
  return { state: { ...base, streakStartedAt }, change: null };
}

export function applyOutcome(
  state: MonitorState,
  ok: boolean,
  now: number,
  thresholds: Thresholds,
): Transition {
  return ok ? afterSuccess(state, now, thresholds) : afterFailure(state, now, thresholds);
}
