import { describeEvent } from './format.js';
import { postJson, type PostContext } from './http-post.js';
import type { DiscordChannel, NotificationEvent, Notifier } from './types.js';

const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4000;
const COLORS = { critical: 0xe74c3c, resolved: 0x2ecc71, warning: 0xf1c40f };

type ContextFactory = (signal: AbortSignal) => PostContext;

export class DiscordNotifier implements Notifier {
  constructor(
    private readonly channel: DiscordChannel,
    private readonly context: ContextFactory,
  ) {}

  async send(event: NotificationEvent, signal: AbortSignal): Promise<void> {
    const { title, lines, severity } = describeEvent(event);
    const payload = {
      username: 'server-monitor',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: title.slice(0, MAX_TITLE_LENGTH),
          description: lines.join('\n').slice(0, MAX_DESCRIPTION_LENGTH),
          color: COLORS[severity],
          timestamp: new Date(event.at).toISOString(),
        },
      ],
    };
    await postJson(this.channel.url, JSON.stringify(payload), {}, this.context(signal));
  }
}
