import type { CheckRecord } from './types.js';

const PERCENT = 100;
const P95 = 0.95;
const PERCENT_PRECISION = 1000;
const RESPONSE_PRECISION = 10;

export interface TimeWindow {
  from: number;
  to: number;
}

export interface UptimeResult {
  uptimePercent: number | null;
  upMs: number;
  downMs: number;
  coveredMs: number;
  checks: number;
}

export interface ResponseStats {
  averageMs: number | null;
  p95Ms: number | null;
  samples: number;
}

export function computeUptime(
  records: readonly Pick<CheckRecord, 'timestamp' | 'ok'>[],
  window: TimeWindow,
  maxGapMs: number,
): UptimeResult {
  const sorted = records.filter((record) => record.timestamp <= window.to);
  sorted.sort((left, right) => left.timestamp - right.timestamp);
  let upMs = 0;
  let downMs = 0;
  let checks = 0;
  sorted.forEach((record, index) => {
    const next = sorted[index + 1];
    const coverageEnd = Math.min(
      next === undefined ? window.to : next.timestamp,
      record.timestamp + maxGapMs,
      window.to,
    );
    const start = Math.max(record.timestamp, window.from);
    if (record.timestamp >= window.from) checks += 1;
    if (coverageEnd <= start) return;
    if (record.ok) upMs += coverageEnd - start;
    else downMs += coverageEnd - start;
  });
  const coveredMs = upMs + downMs;
  const uptimePercent =
    coveredMs === 0
      ? null
      : Math.round((upMs / coveredMs) * PERCENT * PERCENT_PRECISION) / PERCENT_PRECISION;
  return { uptimePercent, upMs, downMs, coveredMs, checks };
}

export function computeResponseStats(
  records: readonly Pick<CheckRecord, 'timestamp' | 'ok' | 'responseTimeMs'>[],
  window: TimeWindow,
): ResponseStats {
  const times = records
    .filter(
      (record) => record.ok && record.timestamp >= window.from && record.timestamp <= window.to,
    )
    .flatMap((record) => (record.responseTimeMs === null ? [] : [record.responseTimeMs]))
    .sort((left, right) => left - right);
  if (times.length === 0) return { averageMs: null, p95Ms: null, samples: 0 };
  const total = times.reduce((sum, value) => sum + value, 0);
  const rank = Math.max(Math.ceil(P95 * times.length) - 1, 0);
  return {
    averageMs: Math.round((total / times.length) * RESPONSE_PRECISION) / RESPONSE_PRECISION,
    p95Ms: times[rank] ?? null,
    samples: times.length,
  };
}
