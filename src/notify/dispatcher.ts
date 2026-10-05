import { describeError } from '../core/run-check.js';
import type { TargetGuard } from '../core/ssrf.js';
import type { Monitor } from '../core/types.js';
import type { Storage } from '../storage/types.js';
import { DiscordNotifier } from './discord.js';
import { EmailNotifier } from './email.js';
import { withRetry } from './retry.js';
import type { Channel, NotificationEvent, Notifier } from './types.js';
import { WebhookNotifier } from './webhook.js';

export interface DispatcherOptions {
  storage: Storage;
  guard: TargetGuard;
  ca?: string | Buffer;
  attempts?: number;
  baseDelayMs?: number;
  attemptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryResult {
  channelId: string;
  delivered: boolean;
  error: string | null;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15_000;

export function createNotifier(
  channel: Channel,
  guard: TargetGuard,
  ca: string | Buffer | undefined,
): Notifier {
  const withCa = ca === undefined ? {} : { ca };
  if (channel.type === 'discord') {
    return new DiscordNotifier(channel, (signal) => ({ guard, signal, ...withCa }));
  }
  if (channel.type === 'webhook') {
    return new WebhookNotifier(channel, (signal) => ({ guard, signal, ...withCa }));
  }
  return new EmailNotifier(channel, { guard, ...withCa });
}

export class NotificationDispatcher {
  constructor(private readonly options: DispatcherOptions) {}

  async dispatch(monitor: Monitor, event: NotificationEvent): Promise<DeliveryResult[]> {
    const channels = (
      await Promise.all(monitor.channelIds.map((id) => this.options.storage.getChannel(id)))
    ).filter((channel): channel is Channel => channel !== undefined);
    return Promise.all(channels.map((channel) => this.deliver(channel, event)));
  }

  private async deliver(channel: Channel, event: NotificationEvent): Promise<DeliveryResult> {
    const { guard, ca, sleep } = this.options;
    const notifier = createNotifier(channel, guard, ca);
    const timeoutMs = this.options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    let lastSignal = AbortSignal.timeout(timeoutMs);
    try {
      await withRetry(
        async () => {
          lastSignal = AbortSignal.timeout(timeoutMs);
          await notifier.send(event, lastSignal);
        },
        {
          attempts: this.options.attempts ?? DEFAULT_ATTEMPTS,
          baseDelayMs: this.options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
          ...(sleep === undefined ? {} : { sleep }),
        },
      );
      return { channelId: channel.id, delivered: true, error: null };
    } catch (error) {
      const reason = error instanceof Error && error.name === 'NotifyError' ? error.message : null;
      return {
        channelId: channel.id,
        delivered: false,
        error: reason ?? describeError(error, lastSignal),
      };
    }
  }
}
