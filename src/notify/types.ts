import type { NotificationKind } from '../core/notify-policy.js';
import type { MonitorType } from '../core/types.js';

export const CHANNEL_TYPES = ['discord', 'webhook', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const EMAIL_SECURITY_MODES = ['tls', 'starttls'] as const;
export type EmailSecurity = (typeof EMAIL_SECURITY_MODES)[number];

interface ChannelBase {
  id: string;
  name: string;
  createdAt: number;
}

export interface DiscordChannel extends ChannelBase {
  type: 'discord';
  url: string;
}

export interface WebhookChannel extends ChannelBase {
  type: 'webhook';
  url: string;
  secret: string;
}

export interface EmailChannel extends ChannelBase {
  type: 'email';
  host: string;
  port: number;
  security: EmailSecurity;
  username: string | null;
  password: string | null;
  from: string;
  to: string[];
}

export type Channel = DiscordChannel | WebhookChannel | EmailChannel;

export interface NotificationEvent {
  kind: NotificationKind;
  at: number;
  monitor: { id: string; name: string; type: MonitorType; target: string };
  incident: {
    id: string;
    startedAt: number;
    resolvedAt: number | null;
    durationMs: number;
    cause: string;
  } | null;
  certificate: { expiresAt: number; daysRemaining: number } | null;
}

export interface Notifier {
  send(event: NotificationEvent, signal: AbortSignal): Promise<void>;
}
