import { describe, expect, it } from 'vitest';
import { computeResponseStats, computeUptime } from '../src/core/uptime.js';

const MINUTE = 60_000;
const GAP = 2 * MINUTE;

const up = (timestamp: number, responseTimeMs: number | null = 100) => ({
  timestamp,
  ok: true,
  responseTimeMs,
});
const down = (timestamp: number) => ({ timestamp, ok: false, responseTimeMs: null });

describe('computeUptime', () => {
  it('returns null when there is no data', () => {
    expect(computeUptime([], { from: 0, to: 10 * MINUTE }, GAP)).toMatchObject({
      uptimePercent: null,
      coveredMs: 0,
      checks: 0,
    });
  });

  it('handles a single check by covering one gap at most', () => {
    const result = computeUptime([up(0)], { from: 0, to: 10 * MINUTE }, GAP);
    expect(result.uptimePercent).toBe(100);
    expect(result.upMs).toBe(GAP);
    expect(result.checks).toBe(1);
  });

  it('weights checks by the time each result covers', () => {
    const records = [up(0), up(MINUTE), down(2 * MINUTE), down(3 * MINUTE), up(4 * MINUTE)];
    const result = computeUptime(records, { from: 0, to: 5 * MINUTE }, GAP);
    expect(result.upMs).toBe(3 * MINUTE);
    expect(result.downMs).toBe(2 * MINUTE);
    expect(result.uptimePercent).toBe(60);
  });

  it('does not count gaps with no data as up or down', () => {
    const records = [up(0), up(MINUTE), up(60 * MINUTE), up(61 * MINUTE)];
    const result = computeUptime(records, { from: 0, to: 62 * MINUTE }, GAP);
    expect(result.coveredMs).toBe(MINUTE + GAP + MINUTE + MINUTE);
    expect(result.uptimePercent).toBe(100);
  });

  it('only counts the part of a check inside a partial window', () => {
    const records = [down(0), up(10 * MINUTE)];
    const result = computeUptime(records, { from: 8 * MINUTE, to: 12 * MINUTE }, 20 * MINUTE);
    expect(result.downMs).toBe(2 * MINUTE);
    expect(result.upMs).toBe(2 * MINUTE);
    expect(result.checks).toBe(1);
  });

  it('ignores records after the window and unsorted input order', () => {
    const records = [up(3 * MINUTE), down(0), down(MINUTE), up(99 * MINUTE)];
    const result = computeUptime(records, { from: 0, to: 4 * MINUTE }, GAP);
    expect(result.downMs).toBe(3 * MINUTE);
    expect(result.upMs).toBe(MINUTE);
  });

  it('reports one decimal-friendly precision', () => {
    const records = [up(0), down(MINUTE), up(2 * MINUTE), up(3 * MINUTE)];
    const result = computeUptime(records, { from: 0, to: 6 * MINUTE }, MINUTE);
    expect(result.uptimePercent).toBe(75);
  });

  it('is zero percent when everything failed', () => {
    const result = computeUptime([down(0), down(MINUTE)], { from: 0, to: 2 * MINUTE }, GAP);
    expect(result.uptimePercent).toBe(0);
  });
});

describe('computeResponseStats', () => {
  const window = { from: 0, to: 100 * MINUTE };

  it('returns nulls without successful checks', () => {
    expect(computeResponseStats([down(0)], window)).toEqual({
      averageMs: null,
      p95Ms: null,
      samples: 0,
    });
  });

  it('computes average and nearest-rank p95', () => {
    const records = Array.from({ length: 100 }, (_, index) => up(index * 1000, index + 1));
    const stats = computeResponseStats(records, window);
    expect(stats.samples).toBe(100);
    expect(stats.averageMs).toBe(50.5);
    expect(stats.p95Ms).toBe(95);
  });

  it('uses the only sample for every percentile', () => {
    expect(computeResponseStats([up(0, 42)], window)).toMatchObject({ averageMs: 42, p95Ms: 42 });
  });

  it('skips failed checks, missing times and out-of-window records', () => {
    const records = [up(0, 10), down(1000), up(2000, null), up(500 * MINUTE, 999)];
    expect(computeResponseStats(records, window)).toMatchObject({ averageMs: 10, samples: 1 });
  });

  it('exposes slow outliers in p95 but not in the median-ish average', () => {
    const records = [...Array.from({ length: 19 }, (_, i) => up(i, 100)), up(20, 5000)];
    expect(computeResponseStats(records, window).p95Ms).toBe(100);
    expect(computeResponseStats([...records, up(21, 5000)], window).p95Ms).toBe(5000);
  });
});
