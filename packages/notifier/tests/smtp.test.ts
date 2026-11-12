import { createServer } from 'node:net';
import { describe, expect, test } from 'bun:test';
import { notifyIncident } from '../src/index';
import { sendSmtpMail, type SmtpConfig } from '../src/smtp';
import type { Incident } from '../src/format';

const incident: Incident = {
  id: 'inc-mail', kind: 'runtime_regression', status: 'pr_opened', detectedAt: '2026-10-23T12:00:00Z', projectId: 'demo',
  actionUrl: 'https://github.com/example/repo/pull/4', evidence: ['HTTP 500'], events: [],
};

function listen(): Promise<{ port: number; received: string[]; close: () => Promise<void> }> {
  const received: string[] = [];
  const server = createServer(socket => {
    socket.write('220 local\r\n');
    let buffer = '';
    let mode: 'command' | 'data' = 'command';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (true) {
        const split = buffer.indexOf('\r\n');
        if (split < 0) return;
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        received.push(line);
        if (mode === 'data') {
          if (line === '.') {
            mode = 'command';
            socket.write('250 queued\r\n');
          }
          continue;
        }
        if (line === 'EHLO sentinel' || line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (line === 'AUTH LOGIN' || line === 'dXNlcg==') socket.write('334 ok\r\n');
        else if (line === 'cGFzcw==') socket.write('235 ok\r\n');
        else if (line === 'DATA') { mode = 'data'; socket.write('354 ok\r\n'); }
        else if (line === 'QUIT') socket.write('221 bye\r\n');
        else socket.write('500 no\r\n');
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, received, close: () => new Promise(done => server.close(() => done())) });
    });
  });
}

describe('smtp notifier', () => {
  test('sends the incident report to a local SMTP server', async () => {
    const server = await listen();
    const smtp: SmtpConfig = {
      host: '127.0.0.1', port: server.port, secure: false, startTls: false,
      user: 'user', password: 'pass', from: 'sentinel@example.com', to: 'judge@example.com', timeoutMs: 3000,
    };
    const result = await notifyIncident(incident, { smtp });
    await server.close();
    expect(result.ok).toBe(true);
    expect(server.received.some(line => line.includes('Subject: Sentinel')) || server.received.join('\n').includes('inc-mail')).toBe(true);
    expect(server.received.join('\n')).toContain('multipart/alternative');
    expect(server.received.join('\n')).toContain('NEXATHON / INCIDENT BRIEF');
    expect(server.received).toContain('AUTH LOGIN');
  });

  test('reports a missing mailbox without calling Slack', async () => {
    const previous = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SMTP_HOST;
    const result = await notifyIncident(incident, {});
    if (previous) process.env.SLACK_WEBHOOK_URL = previous;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Email is not configured');
  });

  test('sendSmtpMail rejects a refused recipient', async () => {
    const server = createServer(socket => {
      socket.write('220 local\r\n');
      socket.on('data', () => socket.write('550 no\r\n'));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await expect(sendSmtpMail({
      host: '127.0.0.1', port, secure: false, startTls: false, from: 'a@example.com', to: 'b@example.com', timeoutMs: 2000,
    }, 'subject', 'body')).rejects.toThrow(/SMTP/);
    server.close();
  });
});
