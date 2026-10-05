import type { TargetGuard } from '../core/ssrf.js';
import type { Storage } from '../storage/types.js';
import { validateChannelInput } from '../validation/channel.js';
import { ValidationError } from '../validation/fields.js';
import { ID_PATTERN } from '../validation/limits.js';
import { validateMonitorInput } from '../validation/monitor.js';
import { HttpError } from './http-utils.js';
import { computeStats, STATS_HORIZON_MS, viewChannel, viewIncident, viewState } from './view.js';

export interface RouteContext {
  storage: Storage;
  guard: TargetGuard;
  now: () => number;
}

export interface RouteRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  readBody: () => Promise<unknown>;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const HTTP_OK = 200;
const HTTP_CREATED = 201;

function ok(body: unknown, status = HTTP_OK): RouteResult {
  return { status, body };
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'resource not found');
}

function methodNotAllowed(): HttpError {
  return new HttpError(405, 'method_not_allowed', 'method not allowed');
}

function parseLimit(query: URLSearchParams): number {
  const raw = query.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new ValidationError([{ field: 'limit', message: `must be between 1 and ${MAX_LIMIT}` }]);
  }
  return value;
}

function parseTimestamp(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError([{ field: name, message: 'must be a millisecond timestamp' }]);
  }
  return value;
}

async function requireMonitor(context: RouteContext, id: string | undefined) {
  const monitor =
    id !== undefined && ID_PATTERN.test(id) ? await context.storage.getMonitor(id) : undefined;
  if (monitor === undefined) throw notFound();
  return monitor;
}

async function assertChannelsExist(context: RouteContext, ids: readonly string[]): Promise<void> {
  const found = await Promise.all(ids.map((id) => context.storage.getChannel(id)));
  const missing = ids.filter((_id, index) => found[index] === undefined);
  if (missing.length > 0) {
    throw new ValidationError([{ field: 'channelIds', message: 'references an unknown channel' }]);
  }
}

async function monitorRoutes(context: RouteContext, request: RouteRequest): Promise<RouteResult> {
  const { storage, now } = context;
  const [, id, sub] = request.segments;
  if (id === undefined) {
    if (request.method === 'GET') {
      const monitors = await storage.listMonitors();
      const states = await Promise.all(monitors.map((monitor) => storage.getState(monitor.id)));
      return ok({
        monitors: monitors.map((monitor, index) => ({
          ...monitor,
          state: viewState(states[index]),
        })),
      });
    }
    if (request.method !== 'POST') throw methodNotAllowed();
    const monitor = validateMonitorInput(await request.readBody(), {
      guard: context.guard,
      now: now(),
    });
    await assertChannelsExist(context, monitor.channelIds);
    await storage.saveMonitor(monitor);
    return ok({ monitor }, HTTP_CREATED);
  }
  const monitor = await requireMonitor(context, id);
  if (sub === undefined) {
    if (request.method === 'GET') {
      const since = now() - STATS_HORIZON_MS;
      const [state, checks] = await Promise.all([
        storage.getState(id),
        storage.listChecks(id, { since }),
      ]);
      return ok({ monitor, state: viewState(state), stats: computeStats(monitor, checks, now()) });
    }
    if (request.method === 'PATCH') {
      const updated = validateMonitorInput(await request.readBody(), {
        guard: context.guard,
        now: now(),
        existing: monitor,
      });
      await assertChannelsExist(context, updated.channelIds);
      await storage.saveMonitor(updated);
      return ok({ monitor: updated });
    }
    if (request.method === 'DELETE') {
      await storage.deleteMonitor(id);
      return ok({ deleted: true });
    }
    throw methodNotAllowed();
  }
  if (request.method !== 'GET') throw methodNotAllowed();
  if (sub === 'checks') {
    const until = parseTimestamp(request.query, 'until');
    const since = parseTimestamp(request.query, 'since');
    const checks = await storage.listChecks(id, {
      newestFirst: true,
      limit: parseLimit(request.query),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    });
    return ok({ checks });
  }
  if (sub === 'incidents') {
    const incidents = await storage.listIncidents({
      monitorId: id,
      limit: parseLimit(request.query),
    });
    return ok({ incidents: incidents.map((incident) => viewIncident(incident, now())) });
  }
  throw notFound();
}

async function channelRoutes(context: RouteContext, request: RouteRequest): Promise<RouteResult> {
  const { storage, now } = context;
  const [, id] = request.segments;
  if (id === undefined) {
    if (request.method === 'GET') {
      return ok({ channels: (await storage.listChannels()).map(viewChannel) });
    }
    if (request.method !== 'POST') throw methodNotAllowed();
    const { channel, generatedSecret } = validateChannelInput(await request.readBody(), now());
    await storage.saveChannel(channel);
    return ok(
      {
        channel: viewChannel(channel),
        ...(generatedSecret === null ? {} : { signingSecret: generatedSecret }),
      },
      HTTP_CREATED,
    );
  }
  const channel = ID_PATTERN.test(id) ? await storage.getChannel(id) : undefined;
  if (channel === undefined) throw notFound();
  if (request.method === 'GET') return ok({ channel: viewChannel(channel) });
  if (request.method !== 'DELETE') throw methodNotAllowed();
  await storage.deleteChannel(id);
  const monitors = await storage.listMonitors();
  const updatedAt = now();
  for (const monitor of monitors.filter((entry) => entry.channelIds.includes(id))) {
    await storage.saveMonitor({
      ...monitor,
      channelIds: monitor.channelIds.filter((entry) => entry !== id),
      updatedAt,
    });
  }
  return ok({ deleted: true });
}

export async function route(context: RouteContext, request: RouteRequest): Promise<RouteResult> {
  const [resource] = request.segments;
  if (resource === 'monitors') return monitorRoutes(context, request);
  if (resource === 'channels') return channelRoutes(context, request);
  if (resource === 'incidents' && request.segments.length === 1) {
    if (request.method !== 'GET') throw methodNotAllowed();
    const incidents = await context.storage.listIncidents({
      limit: parseLimit(request.query),
      openOnly: request.query.get('open') === 'true',
    });
    return ok({ incidents: incidents.map((incident) => viewIncident(incident, context.now())) });
  }
  throw notFound();
}
