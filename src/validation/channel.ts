import { randomBytes, randomUUID } from 'node:crypto';
import { isValidHost } from '../core/target.js';
import { isValidEmailAddress } from '../notify/message.js';
import {
  CHANNEL_TYPES,
  EMAIL_SECURITY_MODES,
  type Channel,
  type ChannelType,
} from '../notify/types.js';
import { Collector, isRecord, ValidationError, type Raw } from './fields.js';
import { LIMITS } from './limits.js';

const GENERATED_SECRET_BYTES = 32;
const DEFAULT_SMTP_PORT = 587;
const COMMON = ['type', 'name'];
const FIELDS: Record<ChannelType, string[]> = {
  discord: [...COMMON, 'url'],
  webhook: [...COMMON, 'url', 'secret'],
  email: [...COMMON, 'host', 'port', 'security', 'username', 'password', 'from', 'to'],
};

interface Base {
  id: string;
  name: string;
  createdAt: number;
}

export interface ChannelValidationResult {
  channel: Channel;
  generatedSecret: string | null;
}

function readUrl(raw: Raw, c: Collector): string {
  const value = c.text(raw, 'url', LIMITS.target.max, true);
  if (value === null) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      c.add('url', 'must be http or https');
    }
    if (url.username !== '' || url.password !== '') c.add('url', 'must not contain credentials');
  } catch {
    c.add('url', 'must be a valid URL');
  }
  return value;
}

function buildWebhook(raw: Raw, base: Base, c: Collector): ChannelValidationResult {
  const url = readUrl(raw, c);
  const supplied = c.text(raw, 'secret', LIMITS.secret.max, false);
  if (supplied !== null && supplied.length < LIMITS.secret.min) {
    c.add('secret', `must be at least ${LIMITS.secret.min} characters`);
  }
  const generated = supplied === null ? randomBytes(GENERATED_SECRET_BYTES).toString('hex') : null;
  return {
    channel: { ...base, type: 'webhook', url, secret: supplied ?? generated ?? '' },
    generatedSecret: generated,
  };
}

function buildEmail(raw: Raw, base: Base, c: Collector): ChannelValidationResult {
  const host = c.text(raw, 'host', LIMITS.target.max, true);
  if (host !== null && !isValidHost(host)) c.add('host', 'must be a hostname or IP address');
  const from = c.text(raw, 'from', LIMITS.target.max, true);
  if (from !== null && !isValidEmailAddress(from)) c.add('from', 'must be an email address');
  const to = c.stringList(raw, 'to', LIMITS.recipients.max, isValidEmailAddress);
  if (to.length === 0) c.add('to', 'must contain at least one email address');
  const username = c.text(raw, 'username', LIMITS.credential.max, false);
  const password = c.text(raw, 'password', LIMITS.credential.max, false);
  if ((username === null) !== (password === null)) {
    c.add('password', 'username and password must be provided together');
  }
  return {
    channel: {
      ...base,
      type: 'email',
      host: host ?? '',
      port: c.integer(raw, 'port', LIMITS.port, DEFAULT_SMTP_PORT),
      security: c.choice(raw, 'security', EMAIL_SECURITY_MODES, 'starttls') ?? 'starttls',
      username,
      password,
      from: from ?? '',
      to,
    },
    generatedSecret: null,
  };
}

export function validateChannelInput(input: unknown, now: number): ChannelValidationResult {
  if (!isRecord(input)) {
    throw new ValidationError([{ field: 'body', message: 'must be an object' }]);
  }
  const c = new Collector();
  const type = c.choice(input, 'type', CHANNEL_TYPES);
  c.rejectUnknown(input, type === null ? COMMON : FIELDS[type]);
  const base: Base = {
    id: randomUUID(),
    name: c.text(input, 'name', LIMITS.name.max, true) ?? '',
    createdAt: now,
  };
  let result: ChannelValidationResult | null = null;
  if (type === 'discord') {
    result = { channel: { ...base, type, url: readUrl(input, c) }, generatedSecret: null };
  } else if (type === 'webhook') {
    result = buildWebhook(input, base, c);
  } else if (type === 'email') {
    result = buildEmail(input, base, c);
  }
  c.finish();
  if (result === null) throw new ValidationError(c.issues);
  return result;
}
