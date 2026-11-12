export * from './format';
import { formatIncidentReport, type Incident, type IncidentReport } from './format';
import { resolveSmtpConfig, sendSmtpMail, type SmtpConfig } from './smtp';
export { resolveSmtpConfig, type SmtpConfig };

export type NotificationResult =
  | { ok: true; report: IncidentReport }
  | { ok: false; reason: 'not_configured' | 'invalid_webhook' | 'timeout' | 'network_error' | 'rejected'; message: string; report: IncidentReport };

export interface NotifyOptions {
  webhookUrl?: string;
  smtp?: SmtpConfig;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export async function notifyIncident(incident: Incident, options: NotifyOptions = {}): Promise<NotificationResult> {
  const report = formatIncidentReport(incident);
  const failure = (reason: Extract<NotificationResult, { ok: false }>['reason'], message: string): NotificationResult => ({ ok: false, reason, message, report });
  let smtp = options.smtp;
  if (!smtp) {
    try { smtp = resolveSmtpConfig(process.env, options.timeoutMs); }
    catch (error) { return failure('invalid_webhook', error instanceof Error ? error.message : 'SMTP configuration is invalid.'); }
  }
  if (smtp) {
    try {
      const subject = `Sentinel · ${incident.status} · ${incident.id}`.slice(0, 180);
      await sendSmtpMail(smtp, subject, report.text, report.html);
      return { ok: true, report };
    } catch (error) {
      const message = error instanceof Error && error.message === 'SMTP timed out.'
        ? 'Email timed out. Recovery and PR creation must continue independently.'
        : 'Email could not be sent. Keep the local report and record notification failure.';
      return failure(error instanceof Error && error.message === 'SMTP timed out.' ? 'timeout' : 'network_error', message);
    }
  }
  const hook = options.webhookUrl ?? process.env.SLACK_WEBHOOK_URL;
  if (!hook) return failure('not_configured', 'Email is not configured. Keep the report locally and record notification failure.');
  try {
    const url = new URL(hook);
    if (url.protocol !== 'https:' || !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash
      || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      return failure('invalid_webhook', 'Slack webhook is invalid. Check the server-side configuration.');
    }
  } catch { return failure('invalid_webhook', 'Slack webhook is invalid. Check the server-side configuration.'); }
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(options.timeoutMs!, 15_000)) : 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<NotificationResult>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(failure('timeout', 'Slack timed out. Recovery and PR creation must continue independently.'));
    }, timeoutMs);
  });
  const send = async (): Promise<NotificationResult> => {
    try {
      const response = await (options.fetch ?? globalThis.fetch)(hook, {
        method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...report, text: report.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), unfurl_links: false, unfurl_media: false, link_names: false, parse: 'none' }),
      });
      if (!response.ok) return failure('rejected', 'Slack rejected the report. Record notification failure; do not retry incident actions.');
      // Slack returns a tiny "ok" body; bound reads instead of echoing remote errors or secrets.
      const reader = response.body?.getReader();
      if (!reader) return failure('rejected', 'Slack did not confirm delivery.');
      let body = '';
      try {
        while (body.length <= 32) {
          const chunk = await reader.read();
          if (chunk.done) break;
          body += new TextDecoder().decode(chunk.value);
        }
      } finally { await reader.cancel(); }
      if (body.trim() !== 'ok') return failure('rejected', 'Slack did not confirm delivery.');
      return { ok: true, report };
    } catch {
      return controller.signal.aborted
        ? failure('timeout', 'Slack timed out. Recovery and PR creation must continue independently.')
        : failure('network_error', 'Slack could not be reached. Keep the local report and record notification failure.');
    }
  };
  try { return await Promise.race([send(), timeout]); }
  finally { clearTimeout(timer); }
}
