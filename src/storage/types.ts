import type { Channel } from '../notify/types.js';
import type { CheckRecord, Incident, Monitor, MonitorState } from '../core/types.js';

export interface CheckQuery {
  since?: number;
  until?: number;
  limit?: number;
  newestFirst?: boolean;
}

export interface IncidentQuery {
  monitorId?: string;
  openOnly?: boolean;
  limit?: number;
}

export interface PruneResult {
  checks: number;
  incidents: number;
}

export interface Storage {
  listMonitors(): Promise<Monitor[]>;
  getMonitor(id: string): Promise<Monitor | undefined>;
  saveMonitor(monitor: Monitor): Promise<void>;
  deleteMonitor(id: string): Promise<boolean>;
  listChannels(): Promise<Channel[]>;
  getChannel(id: string): Promise<Channel | undefined>;
  saveChannel(channel: Channel): Promise<void>;
  deleteChannel(id: string): Promise<boolean>;
  appendCheck(record: CheckRecord): Promise<void>;
  listChecks(monitorId: string, query?: CheckQuery): Promise<CheckRecord[]>;
  getState(monitorId: string): Promise<MonitorState | undefined>;
  saveState(state: MonitorState): Promise<void>;
  getIncident(id: string): Promise<Incident | undefined>;
  saveIncident(incident: Incident): Promise<void>;
  listIncidents(query?: IncidentQuery): Promise<Incident[]>;
  prune(olderThan: number): Promise<PruneResult>;
  close(): Promise<void>;
}
