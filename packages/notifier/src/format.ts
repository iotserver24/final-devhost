import type { Incident } from '@nexathon/contracts';
export type { Incident } from '@nexathon/contracts';

/** Redact credentials while preserving the complete log message and stack trace. */
export function redactFull(value: string): string {
  return value
    .replace(/((?:["']?[\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w.-]*["']?)\s*[:=]\s*)(?!(?:Bearer|Basic)\s)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi, '$1[REDACTED]')
    .replace(/https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[^\s<>"']+/gi, '[REDACTED webhook]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[REDACTED authorization]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED token]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

export function redact(value: string, maxLength = 600): string {
  const clean = redactFull(value);
  const limit = Math.max(1, Math.min(maxLength, 3000));
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function safeLink(value?: string): string | undefined {
  if (!value || value.length > 1000 || /[\s<>|]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    if (redact(value, 3000) !== value) return undefined;
    // Query strings and fragments can carry credentials; action links need neither.
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

export const statusLabels: Record<Incident['status'], string> = {
  detected: 'Detected', investigating: 'Investigating', rolling_back: 'Rolling back',
  remediating: 'Preparing fix', recovered: 'Recovered', pr_opened: 'PR opened', needs_human: 'Fix pending', remediation_failed: 'Fix attempt failed',
};
export const kindLabels: Record<Incident['kind'], string> = {
  runtime_regression: 'Fresh runtime regression', persistent_defect: 'Persistent defect', build_failure: 'Failed build',
};
export const decisionLabels: Record<NonNullable<Incident['decision']>, string> = {
  rollback: 'Rollback', fix_pr: 'Open fix PR', escalate: 'Investigate and prepare fix',
};
export const rollbackCaveat = 'After a Vercel rollback, automatic production-domain assignment can be disabled until a human promotes a repaired deployment.';

function escapeSlack(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('*', '＊').replaceAll('_', '＿').replaceAll('`', '′').replaceAll('~', '～');
}

export interface IncidentReport {
  text: string;
  html: string;
  blocks: Array<{ type: 'section'; text: { type: 'plain_text' | 'mrkdwn'; text: string; emoji?: boolean } }>;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function statusTone(status: Incident['status']): { background: string; text: string } {
  if (status === 'recovered') return { background: '#dcfce7', text: '#166534' };
  if (['needs_human', 'remediation_failed'].includes(status)) return { background: '#fee2e2', text: '#991b1b' };
  if (status === 'rolling_back' || status === 'remediating') return { background: '#fef3c7', text: '#92400e' };
  return { background: '#dbeafe', text: '#1e40af' };
}

export function formatIncidentReport(incident: Incident): IncidentReport {
  const lines = [
    `Nexathon · ${statusLabels[incident.status]}`,
    `Incident: ${redact(incident.id, 120)} · ${kindLabels[incident.kind]}`,
    `Project: ${redact(incident.projectId, 120)}`,
    `Detected: ${redact(incident.detectedAt, 80)}`,
    `Decision: ${incident.decision ? decisionLabels[incident.decision] : 'Not decided'}`,
  ];
  if (incident.deploymentId) lines.push(`Deployment: ${redact(incident.deploymentId, 120)}`);
  if (incident.commitSha) lines.push(`Revision: ${redact(incident.commitSha, 80)}`);
  if (incident.probePath) lines.push(`Probe: ${redact(incident.probePath, 160)}`);
  const evidence = incident.evidence.slice(0, 4).map(item => `• ${redact(item, 350)}`);
  lines.push('Evidence:', ...(evidence.length ? evidence : ['No evidence recorded.']));
  if (incident.evidence.length > 4) lines.push(`${incident.evidence.length - 4} more evidence entries in the incident.`);
  if (incident.events.length) lines.push(`Latest event: ${redact([...incident.events].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!.message, 350)}`);
  if (incident.status === 'pr_opened') lines.push('Pull request is open for review. No code is merged automatically.');
  if (incident.status === 'rolling_back') lines.push('Rollback is in progress; recovery is not yet verified.');
  if (['needs_human', 'remediation_failed'].includes(incident.status)) lines.push('A verified fix PR is not available yet. See the incident timeline for the latest fix attempt and any configuration errors.');
  if (incident.decision === 'rollback') lines.push(rollbackCaveat);
  const action = safeLink(incident.actionUrl);
  if (action) lines.push(`Action: ${action}`);
  const text = lines.join('\n');
  const tone = statusTone(incident.status);
  const evidenceHtml = evidence.length
    ? evidence.map(item => `<li style="margin:0 0 8px;color:#334155;line-height:1.55;">${escapeHtml(item)}</li>`).join('')
    : '<li style="color:#64748b;line-height:1.55;">No evidence recorded.</li>';
  const actionHtml = action
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(action)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px;">${incident.decision === 'fix_pr' ? 'Review pull request' : 'View action'} &rarr;</a></p>`
    : '';
  const notes = [
    incident.status === 'pr_opened' ? 'Pull request is open for review. No code is merged automatically.' : '',
    incident.status === 'rolling_back' ? 'Rollback is in progress; recovery is not yet verified.' : '',
    ['needs_human', 'remediation_failed'].includes(incident.status) ? 'A verified fix PR is not available yet. See the incident timeline for the latest fix attempt and any configuration errors.' : '',
    incident.decision === 'rollback' ? rollbackCaveat : '',
  ].filter(Boolean);
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;color:#0f172a;font-family:Arial,Helvetica,sans-serif;">
<div style="padding:32px 16px;background:#f1f5f9;"><div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
  <div style="padding:28px 32px;background:#0f172a;color:#fff;"><div style="font-size:12px;letter-spacing:1.4px;font-weight:700;color:#93c5fd;">NEXATHON / INCIDENT BRIEF</div>
    <div style="margin-top:18px;font-size:28px;line-height:1.15;font-weight:700;">${escapeHtml(statusLabels[incident.status])}</div>
    <div style="margin-top:14px;"><span style="display:inline-block;background:${tone.background};color:${tone.text};padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700;">${escapeHtml(kindLabels[incident.kind])}</span></div>
  </div>
  <div style="padding:28px 32px;"><p style="margin:0;color:#475569;font-size:15px;line-height:1.55;">An incident update needs your attention. The details below are sanitized for notification.</p>
    <h2 style="margin:28px 0 12px;font-size:16px;color:#0f172a;">Incident details</h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;width:34%;">Incident</td><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;font-weight:600;word-break:break-word;">${escapeHtml(incident.id)}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;">Project</td><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;font-weight:600;word-break:break-word;">${escapeHtml(incident.projectId)}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;">Detected</td><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;">${escapeHtml(incident.detectedAt)}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;">Decision</td><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;">${escapeHtml(incident.decision ? decisionLabels[incident.decision] : 'Not decided')}</td></tr>
      ${incident.deploymentId ? `<tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;">Deployment</td><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;word-break:break-word;">${escapeHtml(incident.deploymentId)}</td></tr>` : ''}
      ${incident.commitSha ? `<tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;">Revision</td><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;word-break:break-word;">${escapeHtml(incident.commitSha)}</td></tr>` : ''}
      ${incident.probePath ? `<tr><td style="padding:9px 0;color:#64748b;">Probe</td><td style="padding:9px 0;word-break:break-word;">${escapeHtml(incident.probePath)}</td></tr>` : ''}
    </table>
    <h2 style="margin:28px 0 12px;font-size:16px;color:#0f172a;">Evidence</h2><ul style="margin:0;padding-left:20px;">${evidenceHtml}</ul>
    ${incident.events.length ? `<h2 style="margin:28px 0 12px;font-size:16px;color:#0f172a;">Latest event</h2><p style="margin:0;color:#334155;line-height:1.55;">${escapeHtml(redact([...incident.events].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!.message, 350))}</p>` : ''}
    ${notes.length ? `<div style="margin-top:28px;padding:16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;"><div style="font-size:12px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.8px;">Important notes</div><ul style="margin:10px 0 0;padding-left:20px;">${notes.map(note => `<li style="margin:0 0 7px;color:#7c2d12;line-height:1.5;">${escapeHtml(note)}</li>`).join('')}</ul></div>` : ''}
    ${actionHtml}
  </div>
  <div style="padding:18px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.5;">Sent by Nexathon. This message is an incident notification; keep the local report as the source of truth.</div>
</div></div></body></html>`;
  const blocks: IncidentReport['blocks'] = [
    { type: 'section', text: { type: 'plain_text', text: text.replace(/\nAction:.*$/, ''), emoji: false } },
  ];
  if (action) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${escapeSlack(action)}|${incident.decision === 'fix_pr' ? 'Review pull request' : 'View action'}>` } });
  return { text, html, blocks };
}
