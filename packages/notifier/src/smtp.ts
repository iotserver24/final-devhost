import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  /** When false, a local or already-clear SMTP server is used without STARTTLS. Default is true for port 587. */
  startTls?: boolean;
  user?: string;
  password?: string;
  from: string;
  to: string;
  timeoutMs: number;
}

const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function resolveSmtpConfig(env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): SmtpConfig | undefined {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();
  const to = env.SMTP_TO?.trim();
  if (!host && !from && !to) return undefined;
  if (!host || !from || !to) throw new Error('SMTP requires SMTP_HOST, SMTP_FROM, and SMTP_TO.');
  if (!emailPattern.test(from) || !emailPattern.test(to)) throw new Error('SMTP_FROM and SMTP_TO must be plain email addresses.');
  const port = Number(env.SMTP_PORT || (env.SMTP_SECURE === 'true' ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT is invalid.');
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(password)) throw new Error('SMTP_USER and SMTP_PASSWORD must be set together.');
  // Port 587 is STARTTLS. Implicit TLS is only for 465, even if SMTP_SECURE was left true.
  const secure = port === 465 || (env.SMTP_SECURE === 'true' && port !== 587);
  return {
    host,
    port,
    secure,
    ...(user ? { user, password } : {}),
    from,
    to,
    timeoutMs,
  };
}

export async function sendSmtpMail(config: SmtpConfig, subject: string, text: string, html?: string): Promise<void> {
  const socket = await openSocket(config);
  const reader = createReader(socket);
  const deadline = setTimeout(() => socket.destroy(new Error('SMTP timed out.')), config.timeoutMs);
  try {
    await session(socket, reader, config, subject, text, html);
  } catch (error) {
    if (socket.destroyed && /timed out/i.test(String(error))) throw new Error('SMTP timed out.');
    throw error instanceof Error && error.message.startsWith('SMTP') ? error : new Error('SMTP connection failed.');
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

function openSocket(config: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? connectTls({ host: config.host, port: config.port, servername: config.host })
      : connectTcp({ host: config.host, port: config.port });
    const ready = config.secure ? 'secureConnect' : 'connect';
    socket.once(ready, () => { socket.pause(); resolve(socket); });
    socket.once('error', () => reject(new Error('SMTP connection failed.')));
  });
}

async function session(socket: Socket | TLSSocket, reader: Reader, config: SmtpConfig, subject: string, text: string, html?: string): Promise<void> {
  await reader.expect([220]);
  await reader.command(socket, 'EHLO sentinel', [250]);
  let active: Socket | TLSSocket = socket;
  let activeReader = reader;
  if (!config.secure && config.startTls !== false) {
    await activeReader.command(active, 'STARTTLS', [220]);
    active = await upgrade(active, config.host);
    activeReader = createReader(active);
    await activeReader.command(active, 'EHLO sentinel', [250]);
  }
  if (config.user && config.password) {
    await activeReader.command(active, 'AUTH LOGIN', [334]);
    await activeReader.command(active, Buffer.from(config.user).toString('base64'), [334]);
    await activeReader.command(active, Buffer.from(config.password).toString('base64'), [235]);
  }
  await activeReader.command(active, `MAIL FROM:<${config.from}>`, [250]);
  await activeReader.command(active, `RCPT TO:<${config.to}>`, [250, 251]);
  await activeReader.command(active, 'DATA', [354]);
  const boundary = `----=_Nexathon_${Date.now().toString(16)}`;
  const message = [
    `From: ${config.from}`,
    `To: ${config.to}`,
    `Subject: ${subject.replace(/[\r\n]/g, ' ').slice(0, 180)}`,
    'MIME-Version: 1.0',
    html ? `Content-Type: multipart/alternative; boundary="${boundary}"` : 'Content-Type: text/plain; charset=utf-8',
    '',
    ...(html ? [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      `--${boundary}--`,
    ] : [text]),
  ].join('\r\n');
  await activeReader.command(active, `${dotStuff(message)}\r\n.`, [250]);
  await activeReader.command(active, 'QUIT', [221]);
}

function upgrade(socket: Socket | TLSSocket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = connectTls({ socket, servername: host });
    tls.once('secureConnect', () => resolve(tls));
    tls.once('error', () => reject(new Error('SMTP connection failed.')));
  });
}

interface Reader {
  expect(codes: number[]): Promise<void>;
  command(socket: Socket | TLSSocket, line: string, codes: number[]): Promise<void>;
}

function createReader(socket: Socket | TLSSocket): Reader {
  let buffer = '';
  const pending: Array<(line: string) => void> = [];
  const queued: string[] = [];
  const fail = () => {
    while (pending.length) pending.shift()?.('');
  };
  const push = (line: string) => {
    const waiter = pending.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  };
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let split = buffer.indexOf('\n');
    while (split >= 0) {
      push(buffer.slice(0, split).replace(/\r$/, ''));
      buffer = buffer.slice(split + 1);
      split = buffer.indexOf('\n');
    }
  });
  socket.on('error', fail);
  socket.on('close', fail);
  socket.resume();
  const nextLine = () => {
    const queuedLine = queued.shift();
    if (queuedLine !== undefined) return Promise.resolve(queuedLine);
    return new Promise<string>(resolve => pending.push(resolve));
  };
  return {
    async expect(codes) {
      let code = 0;
      do {
        const line = await nextLine();
        const match = /^(\d{3})([ -])/.exec(line);
        if (!match) throw new Error('SMTP connection failed.');
        code = Number(match[1]);
        if (match[2] === ' ') break;
      } while (true);
      if (!codes.includes(code)) throw new Error(`SMTP refused the message (${code}).`);
    },
    async command(current, line, codes) {
      current.write(`${line}\r\n`);
      await this.expect(codes);
    },
  };
}

function dotStuff(text: string): string {
  return text.replace(/\r?\n/g, '\r\n').split('\r\n').map(line => line.startsWith('.') ? `.${line}` : line).join('\r\n');
}
