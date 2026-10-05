import type { Socket } from 'node:net';

const MAX_REPLY_BYTES = 64 * 1024;
const REPLY_LINE = /^(\d{3})([ -]|$)/;

export interface SmtpReply {
  code: number;
  lines: string[];
}

export class SmtpConnection {
  private buffer = '';
  private failure: Error | null = null;
  private closed = false;
  private wake: (() => void) | null = null;

  private readonly onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('latin1');
    this.notify();
  };

  constructor(readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('error', (error: Error) => {
      this.failure = error;
      this.notify();
    });
    socket.on('close', () => {
      this.closed = true;
      this.notify();
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private takeReply(): SmtpReply | null {
    const lines: string[] = [];
    let offset = 0;
    for (;;) {
      const end = this.buffer.indexOf('\r\n', offset);
      if (end === -1) return null;
      const line = this.buffer.slice(offset, end);
      const match = REPLY_LINE.exec(line);
      if (match === null) throw new Error('malformed SMTP reply');
      lines.push(line);
      offset = end + 2;
      if (match[2] !== '-') {
        this.buffer = this.buffer.slice(offset);
        return { code: Number(match[1]), lines };
      }
    }
  }

  async readReply(): Promise<SmtpReply> {
    for (;;) {
      const reply = this.takeReply();
      if (reply !== null) return reply;
      if (this.failure !== null) throw this.failure;
      if (this.closed) throw new Error('SMTP connection closed');
      if (this.buffer.length > MAX_REPLY_BYTES) throw new Error('SMTP reply too large');
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  hasPendingInput(): boolean {
    return this.buffer.length > 0;
  }

  detach(): Socket {
    this.socket.off('data', this.onData);
    return this.socket;
  }

  write(text: string): void {
    this.socket.write(text);
  }
}
