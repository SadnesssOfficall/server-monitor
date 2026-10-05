import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_COOLDOWN_MS,
  daysUntil,
  recordNotification,
  shouldNotify,
} from '../src/core/notify-policy.js';
import { applyOutcome, initialState, type Thresholds } from '../src/core/state-machine.js';
import type { MonitorState } from '../src/core/types.js';

const DEFAULT: Thresholds = { failureThreshold: 3, recoveryThreshold: 1 };

function feed(thresholds: Thresholds, results: boolean[]) {
  let state = initialState('m');
  const changes: (string | null)[] = [];
  results.forEach((ok, index) => {
    const transition = applyOutcome(state, ok, (index + 1) * 1000, thresholds);
    state = transition.state;
    changes.push(transition.change);
  });
  return { state, changes };
}

describe('state machine', () => {
  it('starts pending', () => {
    expect(initialState('m').status).toBe('pending');
  });

  it('turns up on the first success', () => {
    const { state, changes } = feed(DEFAULT, [true]);
    expect(state.status).toBe('up');
    expect(changes).toEqual([null]);
  });

  it('does not open an incident before the failure threshold', () => {
    const { state, changes } = feed(DEFAULT, [true, false, false]);
    expect(changes).toEqual([null, null, null]);
    expect(state.status).toBe('up');
    expect(state.consecutiveFailures).toBe(2);
  });

  it('opens an incident on the Nth consecutive failure', () => {
    const { state, changes } = feed(DEFAULT, [true, false, false, false]);
    expect(changes.at(-1)).toBe('incident_opened');
    expect(state.status).toBe('down');
  });

  it('records when the failing streak began', () => {
    const { state } = feed(DEFAULT, [true, false, false, false]);
    expect(state.streakStartedAt).toBe(2000);
  });

  it('suppresses flapping: a success resets the failure streak', () => {
    const { state, changes } = feed(DEFAULT, [false, false, true, false, false, true]);
    expect(changes.every((change) => change === null)).toBe(true);
    expect(state.status).toBe('up');
    expect(state.streakStartedAt).toBeNull();
  });

  it('does not reopen while already down', () => {
    const { changes } = feed(DEFAULT, [false, false, false, false, false]);
    expect(changes.filter((change) => change === 'incident_opened')).toHaveLength(1);
  });

  it('resolves after the recovery threshold', () => {
    const thresholds = { failureThreshold: 1, recoveryThreshold: 2 };
    const { state, changes } = feed(thresholds, [false, true, true]);
    expect(changes).toEqual(['incident_opened', null, 'incident_resolved']);
    expect(state.status).toBe('up');
  });

  it('stays down when recovery is interrupted by a failure', () => {
    const thresholds = { failureThreshold: 1, recoveryThreshold: 2 };
    const { state, changes } = feed(thresholds, [false, true, false, true]);
    expect(changes).toEqual(['incident_opened', null, null, null]);
    expect(state.status).toBe('down');
  });

  it('opens immediately when the threshold is one, even from pending', () => {
    const { changes, state } = feed({ failureThreshold: 1, recoveryThreshold: 1 }, [false]);
    expect(changes).toEqual(['incident_opened']);
    expect(state.streakStartedAt).toBe(1000);
  });

  it('does not mutate its input', () => {
    const before = initialState('m');
    const snapshot = structuredClone(before);
    applyOutcome(before, false, 1, DEFAULT);
    expect(before).toEqual(snapshot);
  });
});

describe('notification policy', () => {
  const monitor = { notificationCooldownSeconds: 60 };
  const base: MonitorState = { ...initialState('m') };

  it('notifies the first incident and honours the cooldown', () => {
    expect(shouldNotify('incident_opened', base, monitor, 1000)).toBe(true);
    const sent = recordNotification(base, 'incident_opened', 1000);
    expect(shouldNotify('incident_opened', sent, monitor, 30_000)).toBe(false);
    expect(shouldNotify('incident_opened', sent, monitor, 61_000)).toBe(true);
  });

  it('only announces recovery for incidents that were announced', () => {
    expect(shouldNotify('incident_resolved', base, monitor, 1000)).toBe(false);
    const sent = recordNotification(base, 'incident_opened', 1000);
    expect(shouldNotify('incident_resolved', sent, monitor, 2000)).toBe(true);
    expect(recordNotification(sent, 'incident_resolved', 2000).incidentNotified).toBe(false);
  });

  it('rate limits certificate warnings to once a day', () => {
    const sent = recordNotification(base, 'certificate_expiring', 0);
    expect(shouldNotify('certificate_expiring', sent, monitor, CERTIFICATE_COOLDOWN_MS - 1)).toBe(
      false,
    );
    expect(shouldNotify('certificate_expiring', sent, monitor, CERTIFICATE_COOLDOWN_MS)).toBe(true);
  });

  it('computes whole days until expiry', () => {
    expect(daysUntil(3.5 * 86_400_000, 0)).toBe(3);
    expect(daysUntil(-1, 0)).toBe(-1);
  });
});
