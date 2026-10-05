import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { TEST_CERT, TEST_KEY } from './fixtures/tls.js';

export interface FakeSmtpOptions {
  mode: 'tls' | 'starttls';
  offerStartTls?: boolean;
  requireAuth?: boolean;
  rejectRecipient?: boolean;
}

export interface FakeSmtp {
  port: number;
  commands: string[];
  messages: string[];
  plaintextCommands: string[];
  close(): Promise<void>;
}

const AUTH_PLAIN = Buffer.from('\u0000user\u0000pass').toString('base64');

function serve(
  socket: net.Socket,
  options: FakeSmtpOptions,
  state: FakeSmtp,
  secure: boolean,
): void {
  let buffer = '';
  let inData = false;
  let message = '';
  const reply = (text: string): void => {
    socket.write(`${text}\r\n`);
  };
  const handleLine = (line: string): void => {
    if (inData) {
      if (line === '.') {
        inData = false;
        state.messages.push(message);
        reply('250 queued');
      } else {
        message += `${line}\r\n`;
      }
      return;
    }
    state.commands.push(line);
    if (!secure) state.plaintextCommands.push(line);
    const verb = line.split(' ')[0]?.toUpperCase();
    if (verb === 'EHLO') {
      const starttls = options.mode === 'starttls' && !secure && options.offerStartTls !== false;
      const lines = ['250-fake', ...(starttls ? ['250-STARTTLS'] : []), '250 AUTH PLAIN LOGIN'];
      socket.write(`${lines.join('\r\n')}\r\n`);
    } else if (verb === 'STARTTLS') {
      reply('220 ready');
      socket.removeAllListeners('data');
      const upgraded = new tls.TLSSocket(socket, {
        isServer: true,
        key: TEST_KEY,
        cert: TEST_CERT,
      });
      upgraded.on('error', () => undefined);
      serve(upgraded, options, state, true);
    } else if (verb === 'AUTH') {
      reply(line.endsWith(AUTH_PLAIN) ? '235 ok' : '535 bad credentials');
    } else if (verb === 'MAIL') {
      reply(
        options.requireAuth === true && !state.commands.some((entry) => entry.startsWith('AUTH'))
          ? '530 auth required'
          : '250 ok',
      );
    } else if (verb === 'RCPT') {
      reply(options.rejectRecipient === true ? '550 no such user' : '250 ok');
    } else if (verb === 'DATA') {
      inData = true;
      reply('354 go');
    } else if (verb === 'QUIT') {
      reply('221 bye');
      socket.end();
    } else {
      reply('500 unknown');
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('latin1');
    let end = buffer.indexOf('\r\n');
    while (end !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handleLine(line);
      end = buffer.indexOf('\r\n');
    }
  });
  socket.on('error', () => undefined);
}

export async function startFakeSmtp(options: FakeSmtpOptions): Promise<FakeSmtp> {
  const state: FakeSmtp = {
    port: 0,
    commands: [],
    messages: [],
    plaintextCommands: [],
    close: () => Promise.resolve(),
  };
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const server =
    options.mode === 'tls'
      ? tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => {
          track(socket);
          socket.write('220 fake ready\r\n');
          serve(socket, options, state, true);
        })
      : net.createServer((socket) => {
          track(socket);
          socket.write('220 fake ready\r\n');
          serve(socket, options, state, false);
        });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        resolve();
      });
    });
  return state;
}
