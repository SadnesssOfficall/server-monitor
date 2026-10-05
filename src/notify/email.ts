import { abortable } from '../core/deadline.js';
import type { TargetGuard } from '../core/ssrf.js';
import { describeEvent } from './format.js';
import { buildMessage } from './message.js';
import { sendMail } from './smtp.js';
import type { EmailChannel, NotificationEvent, Notifier } from './types.js';

export interface EmailContext {
  guard: TargetGuard;
  ca?: string | Buffer;
}

export class EmailNotifier implements Notifier {
  constructor(
    private readonly channel: EmailChannel,
    private readonly context: EmailContext,
  ) {}

  async send(event: NotificationEvent, signal: AbortSignal): Promise<void> {
    const { title, lines } = describeEvent(event);
    const { channel, context } = this;
    const message = buildMessage({
      from: channel.from,
      to: channel.to,
      subject: `[server-monitor] ${title}`,
      text: lines.join('\r\n'),
      date: new Date(event.at),
    });
    const target = await abortable(context.guard.resolve(channel.host), signal);
    await sendMail({
      host: channel.host,
      port: channel.port,
      security: channel.security,
      username: channel.username,
      password: channel.password,
      from: channel.from,
      recipients: channel.to,
      message,
      target,
      signal,
      ...(context.ca === undefined ? {} : { ca: context.ca }),
    });
  }
}
