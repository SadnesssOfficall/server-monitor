import { describe, expect, it } from 'vitest';
import { TargetGuard } from '../src/core/ssrf.js';
import { EmailNotifier } from '../src/notify/email.js';
import { buildMessage, isValidEmailAddress } from '../src/notify/message.js';
import type { EmailChannel, NotificationEvent } from '../src/notify/types.js';
import { openGuard, TEST_CERT } from './helpers.js';
import { startFakeSmtp } from './smtp-server.js';

const event: NotificationEvent = {
  kind: 'incident_resolved',
  at: Date.UTC(2026, 9, 5, 12, 0, 0),
  monitor: { id: 'm', name: 'Shop', type: 'https', target: 'https://shop.example/' },
  incident: { id: 'i', startedAt: 0, resolvedAt: 120_000, durationMs: 120_000, cause: 'timeout' },
  certificate: null,
};

const channel = (port: number, overrides: Partial<EmailChannel> = {}): EmailChannel => ({
  id: 'e',
  name: 'mail',
  type: 'email',
  host: '127.0.0.1',
  port,
  security: 'starttls',
  username: null,
  password: null,
  from: 'monitor@example.com',
  to: ['ops@example.com'],
  createdAt: 0,
  ...overrides,
});

const send = (config: EmailChannel, ca: string | null = TEST_CERT) =>
  new EmailNotifier(config, { guard: openGuard, ...(ca === null ? {} : { ca }) }).send(
    event,
    AbortSignal.timeout(5000),
  );

function decodeBody(raw: string): string {
  const body = raw.split('\r\n\r\n')[1] ?? '';
  return Buffer.from(body.replaceAll('\r\n', ''), 'base64').toString('utf8');
}

describe('email addresses and messages', () => {
  it.each(['a@b.co', 'first.last+tag@example.com'])('accepts %s', (address) => {
    expect(isValidEmailAddress(address)).toBe(true);
  });

  it.each([
    '',
    'plain',
    'a@',
    '@b.co',
    'a b@c.co',
    'a@b.co\r\nBcc: evil@x.co',
    'a<b>@c.co',
    'a@b..',
  ])('rejects %j', (address) => {
    expect(isValidEmailAddress(address)).toBe(false);
  });

  it('neutralises header injection in the subject', () => {
    const raw = buildMessage({
      from: 'a@example.com',
      to: ['b@example.com'],
      subject: 'Hello\r\nBcc: attacker@example.com',
      text: 'body',
      date: new Date(0),
    });
    const headers = raw.split('\r\n\r\n')[0] ?? '';
    expect(headers.split('\r\n').some((line) => line.startsWith('Bcc:'))).toBe(false);
  });

  it('encodes non-ASCII subjects and bodies, and refuses invalid recipients', () => {
    const raw = buildMessage({
      from: 'a@example.com',
      to: ['b@example.com'],
      subject: 'Kesinti: çalışmıyor',
      text: 'satır\r\n.nokta',
      date: new Date(0),
    });
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(decodeBody(raw)).toBe('satır\r\n.nokta');
    expect(() =>
      buildMessage({
        from: 'a@example.com',
        to: ['bad'],
        subject: 's',
        text: 't',
        date: new Date(),
      }),
    ).toThrow('invalid email address');
    expect(() =>
      buildMessage({ from: 'a@example.com', to: [], subject: 's', text: 't', date: new Date() }),
    ).toThrow('invalid email address');
  });
});

describe('smtp delivery', () => {
  it('delivers over STARTTLS and never sends commands in plaintext after upgrade', async () => {
    const smtp = await startFakeSmtp({ mode: 'starttls' });
    try {
      await send(channel(smtp.port));
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]).toContain('Subject: [server-monitor] RECOVERED: Shop');
      expect(decodeBody(smtp.messages[0] ?? '')).toContain('Downtime: 2m');
      expect(smtp.plaintextCommands).toEqual(['EHLO server-monitor', 'STARTTLS']);
      expect(smtp.commands).toContain('MAIL FROM:<monitor@example.com>');
      expect(smtp.commands).toContain('RCPT TO:<ops@example.com>');
    } finally {
      await smtp.close();
    }
  });

  it('delivers over implicit TLS', async () => {
    const smtp = await startFakeSmtp({ mode: 'tls' });
    try {
      await send(channel(smtp.port, { security: 'tls' }));
      expect(smtp.messages).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });

  it('authenticates only after TLS is established', async () => {
    const smtp = await startFakeSmtp({ mode: 'starttls', requireAuth: true });
    try {
      await send(channel(smtp.port, { username: 'user', password: 'pass' }));
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.plaintextCommands.some((line) => line.startsWith('AUTH'))).toBe(false);
    } finally {
      await smtp.close();
    }
  });

  it('fails permanently on bad credentials', async () => {
    const smtp = await startFakeSmtp({ mode: 'starttls' });
    try {
      await expect(
        send(channel(smtp.port, { username: 'user', password: 'wrong' })),
      ).rejects.toMatchObject({ message: 'SMTP error 535', retryable: false });
    } finally {
      await smtp.close();
    }
  });

  it('refuses to fall back to plaintext when STARTTLS is not offered', async () => {
    const smtp = await startFakeSmtp({ mode: 'starttls', offerStartTls: false });
    try {
      await expect(
        send(channel(smtp.port, { username: 'user', password: 'pass' })),
      ).rejects.toThrow('does not offer STARTTLS');
      expect(smtp.plaintextCommands.some((line) => line.startsWith('AUTH'))).toBe(false);
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('rejects an untrusted server certificate', async () => {
    const smtp = await startFakeSmtp({ mode: 'starttls' });
    try {
      await expect(send(channel(smtp.port), null)).rejects.toThrow();
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('rejects a certificate for another hostname', async () => {
    const smtp = await startFakeSmtp({ mode: 'tls' });
    try {
      const guard = new TargetGuard({
        allowPrivateTargets: true,
        resolver: () => Promise.resolve(['127.0.0.1']),
      });
      const notifier = new EmailNotifier(
        channel(smtp.port, { host: 'mail.other.example', security: 'tls' }),
        { guard, ca: TEST_CERT },
      );
      await expect(notifier.send(event, AbortSignal.timeout(5000))).rejects.toThrow();
      expect(smtp.messages).toHaveLength(0);
    } finally {
      await smtp.close();
    }
  });

  it('treats a rejected recipient as a permanent error', async () => {
    const smtp = await startFakeSmtp({ mode: 'starttls', rejectRecipient: true });
    try {
      await expect(send(channel(smtp.port))).rejects.toMatchObject({
        message: 'SMTP error 550',
        retryable: false,
      });
    } finally {
      await smtp.close();
    }
  });

  it('refuses private SMTP hosts by default', async () => {
    const smtp = await startFakeSmtp({ mode: 'starttls' });
    try {
      const guard = new TargetGuard();
      const notifier = new EmailNotifier(channel(smtp.port), { guard, ca: TEST_CERT });
      await expect(notifier.send(event, AbortSignal.timeout(2000))).rejects.toThrow('blocked');
      expect(smtp.commands).toEqual([]);
    } finally {
      await smtp.close();
    }
  });
});
