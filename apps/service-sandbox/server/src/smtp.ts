import { createServer, type Server, type Socket } from 'node:net';
import { SMTP } from './constants.js';
import type { FixtureLog } from './log.js';

export interface MailMessage {
  id: number;
  at: string;
  from: string;
  to: string[];
  subject: string;
  raw: string;
}

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

function subjectOf(raw: string): string {
  const head = raw.split(/\r?\n\r?\n/, 1)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const line = unfolded.split(/\r?\n/).find((l) => /^subject:/i.test(l));
  const value = line?.slice(8).trim() ?? '';
  return value.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_m, enc: string, text: string) =>
    enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64').toString('utf8') : decodeURIComponent(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, '%$1')),
  );
}

const address = (arg: string) => /<([^>]*)>/.exec(arg)?.[1] ?? arg.trim();

/** A plain SMTP listener that accepts the demo user (AUTH PLAIN or LOGIN) and keeps each message in memory. */
export class SmtpFixture {
  readonly messages: MailMessage[] = [];
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private next = 1;

  constructor(private readonly log: FixtureLog) {}

  listen(port: number, host: string): Promise<number> {
    const server = createServer((socket) => this.session(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  find(id: number): MailMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  private session(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    let buffer = '';
    let authed = false;
    let from: string | null = null;
    let to: string[] = [];
    let mode: 'command' | 'data' | 'login-user' | 'login-pass' | 'plain' = 'command';
    let loginUser = '';
    let data: string[] = [];
    let dataBytes = 0;
    const reply = (text: string) => socket.write(`${text}\r\n`);
    const accept = (user: string, password: string) => {
      authed = user === SMTP.user && password === SMTP.password;
      this.log.add('smtp', authed ? `Signed in as ${user}` : `Sign-in refused for ${user}`);
      reply(authed ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid');
    };
    const plain = (b64: string) => {
      const [, user = '', password = ''] = Buffer.from(b64, 'base64').toString('utf8').split('\0');
      accept(user, password);
    };

    const line = (text: string) => {
      if (mode === 'data') {
        if (text === '.') {
          mode = 'command';
          const raw = data.join('\r\n');
          const message: MailMessage = { id: this.next++, at: new Date().toISOString(), from: from ?? '', to, subject: subjectOf(raw), raw };
          this.messages.unshift(message);
          if (this.messages.length > 200) this.messages.pop();
          this.log.add('smtp', `Message ${message.id} to ${to.join(', ')}: ${message.subject || '(no subject)'}`, { id: message.id });
          from = null;
          to = [];
          data = [];
          dataBytes = 0;
          return reply(`250 2.0.0 OK queued as ${message.id}`);
        }
        dataBytes += text.length + 2;
        if (dataBytes <= MAX_MESSAGE_BYTES) data.push(text.startsWith('..') ? text.slice(1) : text);
        return;
      }
      if (mode === 'login-user') {
        loginUser = Buffer.from(text, 'base64').toString('utf8');
        mode = 'login-pass';
        return reply('334 UGFzc3dvcmQ6');
      }
      if (mode === 'login-pass') {
        mode = 'command';
        return accept(loginUser, Buffer.from(text, 'base64').toString('utf8'));
      }
      if (mode === 'plain') {
        mode = 'command';
        return plain(text);
      }
      const [verb = '', ...rest] = text.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          return socket.write('250-service-sandbox\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 10485760\r\n');
        case 'HELO':
          return reply('250 service-sandbox');
        case 'AUTH': {
          const [mech = '', initial] = arg.split(' ');
          if (mech.toUpperCase() === 'PLAIN') {
            if (initial) return plain(initial);
            mode = 'plain';
            return reply('334 ');
          }
          if (mech.toUpperCase() === 'LOGIN') {
            if (initial) {
              loginUser = Buffer.from(initial, 'base64').toString('utf8');
              mode = 'login-pass';
              return reply('334 UGFzc3dvcmQ6');
            }
            mode = 'login-user';
            return reply('334 VXNlcm5hbWU6');
          }
          return reply('504 5.5.4 Unrecognized authentication type');
        }
        case 'MAIL':
          if (!authed) return reply('530 5.7.0 Authentication required');
          from = address(arg.replace(/^FROM:/i, '').split(' ')[0] ?? '');
          to = [];
          return reply('250 2.1.0 OK');
        case 'RCPT':
          if (from === null) return reply('503 5.5.1 MAIL first');
          to.push(address(arg.replace(/^TO:/i, '')));
          return reply('250 2.1.5 OK');
        case 'DATA':
          if (!to.length) return reply('503 5.5.1 RCPT first');
          mode = 'data';
          return reply('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET':
          from = null;
          to = [];
          return reply('250 2.0.0 OK');
        case 'NOOP':
          return reply('250 2.0.0 OK');
        case 'QUIT':
          reply('221 2.0.0 Bye');
          return socket.end();
        default:
          return reply('502 5.5.2 Command not recognised');
      }
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const text = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        line(text);
      }
    });
    socket.on('error', () => socket.destroy());
    reply('220 service-sandbox ESMTP ready');
  }
}
