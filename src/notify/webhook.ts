import { createHmac, timingSafeEqual } from 'node:crypto';
import { MS_PER_SECOND } from '../core/types.js';
import { postJson, type PostContext } from './http-post.js';
import type { NotificationEvent, Notifier, WebhookChannel } from './types.js';

export const SIGNATURE_HEADER = 'X-Monitor-Signature';
export const TIMESTAMP_HEADER = 'X-Monitor-Timestamp';
export const EVENT_HEADER = 'X-Monitor-Event';
export const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_PREFIX = 'sha256=';

type ContextFactory = (signal: AbortSignal) => PostContext;

export function signPayload(secret: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

export interface VerifyOptions {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  toleranceSeconds?: number;
  now?: number;
}

export function verifyWebhookSignature(options: VerifyOptions): boolean {
  const { secret, timestamp, body, signature } = options;
  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt)) return false;
  const now = options.now ?? Date.now();
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now / MS_PER_SECOND - sentAt) > tolerance) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export class WebhookNotifier implements Notifier {
  constructor(
    private readonly channel: WebhookChannel,
    private readonly context: ContextFactory,
  ) {}

  async send(event: NotificationEvent, signal: AbortSignal): Promise<void> {
    const body = JSON.stringify({ ...event, timestamp: new Date(event.at).toISOString() });
    const timestamp = String(Math.floor(Date.now() / MS_PER_SECOND));
    await postJson(
      this.channel.url,
      body,
      {
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signPayload(this.channel.secret, timestamp, body),
        [EVENT_HEADER]: event.kind,
      },
      this.context(signal),
    );
  }
}
