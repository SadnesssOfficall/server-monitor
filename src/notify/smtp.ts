import net from 'node:net';
import tls from 'node:tls';
import type { ResolvedTarget } from '../core/ssrf.js';
import { NotifyError } from './retry.js';
import { SmtpConnection, type SmtpReply } from './smtp-connection.js';
import type { EmailSecurity } from './types.js';

const SERVER_ERROR_CLASS = 5;
const CODE_DIVISOR = 100;
const READY = 220;
const OK = 250;
const AUTH_OK = 235;
const AUTH_CONTINUE = 334;
const START_DATA = 354;
const RECIPIENT_FORWARDED = 251;
const CLIENT_NAME = 'server-monitor';

export interface MailOptions {
  host: string;
  port: number;
  security: EmailSecurity;
  username: string | null;
  password: string | null;
  from: string;
  recipients: readonly string[];
  message: string;
  target: ResolvedTarget;
  signal: AbortSignal;
  ca?: string | Buffer;
}

function expect(reply: SmtpReply, ...codes: number[]): SmtpReply {
  if (codes.includes(reply.code)) return reply;
  const permanent = Math.floor(reply.code / CODE_DIVISOR) === SERVER_ERROR_CLASS;
  throw new NotifyError(`SMTP error ${reply.code}`, !permanent);
}

function capabilities(reply: SmtpReply): string[] {
  return reply.lines.map((line) => line.slice(4).toUpperCase());
}

function connectPlain(options: MailOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: options.target.address, port: options.port });
    socket.once('connect', () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function secure(socket: net.Socket | null, options: MailOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      ...(socket === null
        ? { host: options.target.address, port: options.port }
        : { socket, host: options.host }),
      ...(net.isIP(options.host) === 0 ? { servername: options.host } : {}),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    });
    tlsSocket.once('secureConnect', () => {
      resolve(tlsSocket);
    });
    tlsSocket.once('error', reject);
  });
}

async function command(connection: SmtpConnection, line: string): Promise<SmtpReply> {
  connection.write(`${line}\r\n`);
  return connection.readReply();
}

async function openSession(options: MailOptions): Promise<SmtpConnection> {
  if (options.security === 'tls') {
    const connection = new SmtpConnection(await secure(null, options));
    expect(await connection.readReply(), READY);
    return connection;
  }
  let connection = new SmtpConnection(await connectPlain(options));
  expect(await connection.readReply(), READY);
  const hello = expect(await command(connection, `EHLO ${CLIENT_NAME}`), OK);
  if (!capabilities(hello).includes('STARTTLS')) {
    throw new NotifyError('server does not offer STARTTLS', false);
  }
  expect(await command(connection, 'STARTTLS'), READY);
  if (connection.hasPendingInput()) throw new NotifyError('unexpected data before TLS', false);
  connection = new SmtpConnection(await secure(connection.detach(), options));
  return connection;
}

async function authenticate(connection: SmtpConnection, options: MailOptions): Promise<void> {
  if (options.username === null || options.password === null) return;
  const hello = expect(await command(connection, `EHLO ${CLIENT_NAME}`), OK);
  const methods = capabilities(hello).find((entry) => entry.startsWith('AUTH '));
  const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64');
  if (methods?.split(' ').includes('PLAIN') === true) {
    const credentials = encode(`\u0000${options.username}\u0000${options.password}`);
    expect(await command(connection, `AUTH PLAIN ${credentials}`), AUTH_OK);
  } else if (methods?.split(' ').includes('LOGIN') === true) {
    expect(await command(connection, 'AUTH LOGIN'), AUTH_CONTINUE);
    expect(await command(connection, encode(options.username)), AUTH_CONTINUE);
    expect(await command(connection, encode(options.password)), AUTH_OK);
  } else {
    throw new NotifyError('server does not offer a supported AUTH method', false);
  }
}

export async function sendMail(options: MailOptions): Promise<void> {
  const connection = await openSession(options);
  const abort = (): void => {
    connection.socket.destroy();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    if (options.security === 'tls' || options.username === null) {
      expect(await command(connection, `EHLO ${CLIENT_NAME}`), OK);
    }
    await authenticate(connection, options);
    expect(await command(connection, `MAIL FROM:<${options.from}>`), OK);
    for (const recipient of options.recipients) {
      expect(await command(connection, `RCPT TO:<${recipient}>`), OK, RECIPIENT_FORWARDED);
    }
    expect(await command(connection, 'DATA'), START_DATA);
    expect(await command(connection, `${options.message}\r\n.`), OK);
    connection.write('QUIT\r\n');
  } finally {
    options.signal.removeEventListener('abort', abort);
    connection.socket.destroy();
  }
}
