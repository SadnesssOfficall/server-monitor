import type { Channel } from '../notify/types.js';
import type { CheckRecord, Incident, Monitor, MonitorState } from '../core/types.js';
import type { CheckQuery, IncidentQuery, PruneResult, Storage } from './types.js';

export interface Dataset {
  monitors: Record<string, Monitor>;
  channels: Record<string, Channel>;
  states: Record<string, MonitorState>;
  incidents: Record<string, Incident>;
  checks: Record<string, CheckRecord[]>;
}

export function emptyDataset(): Dataset {
  return { monitors: {}, channels: {}, states: {}, incidents: {}, checks: {} };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

export class MemoryStorage implements Storage {
  constructor(readonly data: Dataset = emptyDataset()) {}

  listMonitors(): Promise<Monitor[]> {
    return Promise.resolve(copy(Object.values(this.data.monitors)));
  }

  getMonitor(id: string): Promise<Monitor | undefined> {
    return Promise.resolve(copy(this.data.monitors[id]));
  }

  saveMonitor(monitor: Monitor): Promise<void> {
    this.data.monitors[monitor.id] = copy(monitor);
    return Promise.resolve();
  }

  deleteMonitor(id: string): Promise<boolean> {
    const existed = id in this.data.monitors;
    this.data.monitors = without(this.data.monitors, id);
    this.data.states = without(this.data.states, id);
    this.data.checks = without(this.data.checks, id);
    this.data.incidents = Object.fromEntries(
      Object.entries(this.data.incidents).filter(([, incident]) => incident.monitorId !== id),
    );
    return Promise.resolve(existed);
  }

  listChannels(): Promise<Channel[]> {
    return Promise.resolve(copy(Object.values(this.data.channels)));
  }

  getChannel(id: string): Promise<Channel | undefined> {
    return Promise.resolve(copy(this.data.channels[id]));
  }

  saveChannel(channel: Channel): Promise<void> {
    this.data.channels[channel.id] = copy(channel);
    return Promise.resolve();
  }

  deleteChannel(id: string): Promise<boolean> {
    const existed = id in this.data.channels;
    this.data.channels = without(this.data.channels, id);
    return Promise.resolve(existed);
  }

  appendCheck(record: CheckRecord): Promise<void> {
    if (record.monitorId in this.data.monitors) {
      const list = this.data.checks[record.monitorId] ?? [];
      list.push(copy(record));
      this.data.checks[record.monitorId] = list;
    }
    return Promise.resolve();
  }

  listChecks(monitorId: string, query: CheckQuery = {}): Promise<CheckRecord[]> {
    const { since = -Infinity, until = Infinity, limit, newestFirst = false } = query;
    const selected = (this.data.checks[monitorId] ?? [])
      .filter((record) => record.timestamp >= since && record.timestamp <= until)
      .sort((left, right) => left.timestamp - right.timestamp);
    if (newestFirst) selected.reverse();
    return Promise.resolve(copy(limit === undefined ? selected : selected.slice(0, limit)));
  }

  getState(monitorId: string): Promise<MonitorState | undefined> {
    return Promise.resolve(copy(this.data.states[monitorId]));
  }

  saveState(state: MonitorState): Promise<void> {
    if (state.monitorId in this.data.monitors) this.data.states[state.monitorId] = copy(state);
    return Promise.resolve();
  }

  getIncident(id: string): Promise<Incident | undefined> {
    return Promise.resolve(copy(this.data.incidents[id]));
  }

  saveIncident(incident: Incident): Promise<void> {
    if (incident.monitorId in this.data.monitors) this.data.incidents[incident.id] = copy(incident);
    return Promise.resolve();
  }

  listIncidents(query: IncidentQuery = {}): Promise<Incident[]> {
    const selected = Object.values(this.data.incidents)
      .filter((incident) => query.monitorId === undefined || incident.monitorId === query.monitorId)
      .filter((incident) => query.openOnly !== true || incident.resolvedAt === null)
      .sort((left, right) => right.startedAt - left.startedAt);
    return Promise.resolve(
      copy(query.limit === undefined ? selected : selected.slice(0, query.limit)),
    );
  }

  prune(olderThan: number): Promise<PruneResult> {
    let checks = 0;
    for (const [monitorId, list] of Object.entries(this.data.checks)) {
      const kept = list.filter((record) => record.timestamp >= olderThan);
      checks += list.length - kept.length;
      this.data.checks[monitorId] = kept;
    }
    const keptIncidents = Object.entries(this.data.incidents).filter(
      ([, incident]) => incident.resolvedAt === null || incident.resolvedAt >= olderThan,
    );
    const incidents = Object.keys(this.data.incidents).length - keptIncidents.length;
    this.data.incidents = Object.fromEntries(keptIncidents);
    return Promise.resolve({ checks, incidents });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
