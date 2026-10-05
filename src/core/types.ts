export const MONITOR_TYPES = ['http', 'https', 'tcp', 'ping', 'keyword'] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export const KEYWORD_MODES = ['present', 'absent'] as const;
export type KeywordMode = (typeof KEYWORD_MODES)[number];

export interface StatusRange {
  min: number;
  max: number;
}

export interface Monitor {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  enabled: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: StatusRange;
  maxRedirects: number;
  failureThreshold: number;
  recoveryThreshold: number;
  keyword: string | null;
  keywordMode: KeywordMode;
  maxBodyBytes: number;
  certExpiryWarnDays: number;
  notificationCooldownSeconds: number;
  channelIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CheckOutcome {
  ok: boolean;
  responseTimeMs: number | null;
  statusCode: number | null;
  error: string | null;
  certExpiresAt: number | null;
}

export interface CheckRecord extends CheckOutcome {
  monitorId: string;
  timestamp: number;
}

export const MONITOR_STATUSES = ['pending', 'up', 'down'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export interface MonitorState {
  monitorId: string;
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  streakStartedAt: number | null;
  lastCheckAt: number | null;
  openIncidentId: string | null;
  incidentNotified: boolean;
  lastNotified: Record<string, number>;
}

export interface Incident {
  id: string;
  monitorId: string;
  startedAt: number;
  resolvedAt: number | null;
  cause: string;
}

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
