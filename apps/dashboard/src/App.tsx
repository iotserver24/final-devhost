'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { Setup } from './Setup';
import {
  decisionLabels,
  kindLabels,
  rollbackCaveat,
  statusLabels,
  type Incident,
} from '@nexathon/notifier/format';
import { useIncidents, type DataMode } from './useIncidents';
import { AgentTranscript } from './AgentTranscript';
import { useActivity } from './useActivity';
import {
  ActionAudit,
  AffectedServices,
  EscalationBanner,
  EvidenceItems,
  incidentHeadline,
  RecoveryMetrics,
  Verification,
} from './incident-detail';
import { RichText } from './RichText';
import { groupCopies } from './rich-text';
import { IssueReport } from './IssueReport';

const mode: DataMode = process.env.NEXT_PUBLIC_DATA_MODE === 'fixtures' ? 'fixtures' : 'live';

const runStatusLabels: Record<string, string> = {
  queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Stopped',
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function shortSha(value?: string) {
  return value ? value.slice(0, 7) : '—';
}

function shortDeployment(value?: string) {
  return value ? value.replace(/^dpl_/, '').slice(0, 7) : '—';
}

function everyLabel(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds >= 120 ? `${Math.max(1, Math.round(seconds / 60))}m` : `${seconds}s`;
}

function nextIn(from: string | null | undefined, intervalMs: number, now: Date) {
  if (!from) return '—';
  const remaining = Math.ceil((new Date(from).getTime() + intervalMs - now.getTime()) / 1000);
  return remaining <= 0 ? 'due' : `${remaining}s`;
}

function hostOf(value?: string) {
  if (!value) return '—';
  try { return new URL(value).host; } catch { return value; }
}

function StatusPill({ status }: { status: Incident['status'] }) {
  return <span className={`status status-${status}`}>{statusLabels[status]}</span>;
}

function rolledBack(incident: Incident) {
  return incident.events.some(event => event.type === 'rollback_started' || event.type === 'rollback_completed');
}

function waitingOnComment(incident: Incident) {
  const event = [...incident.events].reverse().find(item => item.type === 'awaiting_comment');
  if (!event) return false;
  return !incident.events.some(item => item.type === 'review_resumed' && item.at > event.at);
}

function actionSummary(incident: Incident) {
  const restored = rolledBack(incident);
  const resumed = incident.events.some(item => item.type === 'review_resumed');
  if (incident.status === 'rolling_back') return 'Rolling production back to the previous deploy. The fix starts after that.';
  if (incident.status === 'remediating' && resumed) return 'The repository comment arrived. The agent is applying that method, running the proof test, and will open a pull request only if the test passes.';
  if (incident.status === 'remediating') return 'The agent is finding the error and writing a regression test that fails on the broken source. It pauses for a repository comment before the fix.';
  if (waitingOnComment(incident)) return 'The failing test is written and the sandbox is paused. Comment on the GitHub issue to choose the method. The fix starts after that comment.';
  if (incident.status === 'pr_opened' && restored) return 'Production was rolled back, then a fix pull request was opened. Nothing has been merged. The sandbox is paused.';
  if (incident.status === 'pr_opened') return 'A pull request is open for review. Nothing has been merged. The sandbox is paused until a later comment.';
  if (incident.status === 'recovered' && restored) return 'Production was restored to the previous deploy. The fix follows that rollback.';
  if (incident.status === 'recovered') return 'Production recovery was verified after the guarded action.';
  if (incident.status === 'remediation_failed') return [...incident.events].reverse()
    .find(event => event.type === 'remediation_failed')?.message ?? 'The latest fix attempt failed. See the timeline for details.';
  if (incident.status === 'needs_human') return 'A repository investigation and fix will be attempted when the failure is observed again.';
  return 'The controller is collecting evidence before taking action.';
}

function decisionSummary(incident: Incident) {
  if (rolledBack(incident) && incident.decision === 'fix_pr') return 'Rolled back, then fix PR';
  if (rolledBack(incident) && incident.status === 'remediating') return 'Rolled back, fix in progress';
  return incident.decision ? decisionLabels[incident.decision] : 'Pending';
}

function IncidentCard({ incident, selected, onSelect, href }: { incident: Incident; selected: boolean; onSelect: () => void; href?: string }) {
  const className = `incident-card${selected ? ' selected' : ''}`;
  const body = <>
      <span className="card-topline"><span>{formatDate(incident.detectedAt)}</span><StatusPill status={incident.status} /></span>
      <strong>{kindLabels[incident.kind]}</strong>
      <span className="card-meta">
        {incident.targetId ? `${incident.targetId} · ` : ''}{decisionSummary(incident)} · {shortSha(incident.commitSha)} · {incident.probePath ?? 'build'}
      </span>
      {(incident.classification || incident.evidenceSources?.length) && <span className="card-tags">
        {incident.classification && <span className={`tag tag-${incident.classification}`}>{incident.classification}</span>}
        {incident.evidenceSources?.map(source => <span className="tag" key={source}>{source}</span>)}
      </span>}
      <span className="card-summary">{incidentHeadline(incident)}</span>
    </>;
  if (href) return <Link className="incident-row" href={href}>
    <StatusPill status={incident.status} />
    <span className="incident-row-copy">
      <strong>{kindLabels[incident.kind]}</strong>
      <span>{incidentHeadline(incident)}</span>
    </span>
    <span className="incident-row-service">{incident.targetId || 'Unassigned'}</span>
    <span className="incident-row-when">{formatDate(incident.detectedAt)}</span>
  </Link>;
  return <button className={className} onClick={onSelect} type="button">{body}</button>;
}

function Timeline({ events }: { events: Incident['events'] }) {
  return <section className="panel timeline-panel">
    <div className="section-heading"><h2>Incident timeline</h2><span>chronological record</span></div>
    <ol className="timeline">
      {events.map((event, index) => <li key={`${event.at}-${event.type}-${index}`}>
        <span className="timeline-dot" aria-hidden="true" />
        <div><div className="timeline-meta"><strong>{event.type.replaceAll('_', ' ')}</strong><time dateTime={event.at}>{formatDate(event.at)}</time></div><RichText text={event.message} /></div>
      </li>)}
    </ol>
  </section>;
}

function LiveActivity({ incidentId }: { incidentId: string }) {
  const [selectedRunId, setSelectedRunId] = useState('');
  const { run, runs, events, error } = useActivity(mode, incidentId, selectedRunId);
  const live = run?.status === 'queued' || run?.status === 'running';
  useEffect(() => setSelectedRunId(''), [incidentId]);
  return <section className="panel activity-panel">
    <div className="section-heading">
      <h2>Agent transcript</h2>
      {run
        ? <span className={`run-badge ${live ? 'live' : run.status}`}>
            {live && <span className="pulse" aria-hidden="true" />}
            {run.source === 'ai' ? 'AI run' : 'Rehearsal'} · {runStatusLabels[run.status]}
          </span>
        : <span>no run yet</span>}
    </div>
    {error && <p className="activity-error" role="status">{error}</p>}
    {!run && <p className="activity-empty">
      {mode === 'fixtures'
        ? 'Fixture data only. Run the local controller to watch an agent work.'
        : 'No saved agent log for this incident yet. The log stays after the sandbox finishes.'}
    </p>}
    {run && <>
      <div className="transcript-run-picker"><label>Run <select value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)}>
        <option value="">Latest run</option>
        {runs.map(candidate => <option key={candidate.id} value={candidate.id}>{formatDate(candidate.startedAt)} · {runStatusLabels[candidate.status]}</option>)}
      </select></label><span>{run.id}</span></div>
      <p className="activity-now" role="status">{events.at(-1)?.message.split('\n')[0] ?? 'Waiting for the first progress event.'}</p>
      <p className="transcript-note">Agent messages and tool details are saved with this run. Credentials are redacted; private internal reasoning is excluded.</p>
      <AgentTranscript key={run.id} events={events} run={run} />
      {run.outcome && <p className="activity-outcome">{run.outcome}</p>}
    </>}
  </section>;
}

function crashLine(log: { level: string; message: string; statusCode?: number; isError: boolean }): boolean {
  return log.isError || (log.statusCode !== undefined && log.statusCode >= 500) || /crash|task service failed|unhandled|exception/i.test(`${log.level} ${log.message}`);
}

type WatchLog = {
  id: string;
  level: string;
  message: string;
  statusCode?: number;
  timestamp: number;
  isError: boolean;
};

function WatchTelemetry({ watch }: { watch: WatchState | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const probe = watch?.probe;
  const logs = watch?.logs ?? [];
  const deployment = watch?.deployment ?? null;
  const probeEvery = everyLabel(watch?.intervalMs ?? 30_000);
  const logsEvery = everyLabel(watch?.logsIntervalMs ?? 30_000);
  const nextProbe = nextIn(watch?.checkedAt, watch?.intervalMs ?? 30_000, now);
  const nextLogs = nextIn(watch?.logsCheckedAt, watch?.logsIntervalMs ?? 30_000, now);
  return <section className="panel telemetry-panel" aria-live="polite">
    <div className="section-heading">
      <h2>Production telemetry</h2>
      <span>probe / {probeEvery} · logs / {logsEvery}</span>
    </div>
    <div className="telemetry-probe">
      <div>
        <span className="telemetry-label">Latest probe</span>
        <strong className={`probe-result ${probe?.result ?? 'unknown'}`}>
          {probe?.result === 'pass' ? 'Succeeded' : probe?.result === 'fail' ? 'Failed' : 'Waiting'}
        </strong>
      </div>
      <div>
        <span className="telemetry-label">Response</span>
        <strong className="mono">{probe?.statusCode ? `HTTP ${probe.statusCode}` : '—'}</strong>
      </div>
      <div>
        <span className="telemetry-label">Checked</span>
        <strong>{probe ? formatTime(probe.checkedAt) : '—'}</strong>
      </div>
      <div>
        <span className="telemetry-label">Next probe</span>
        <strong>{nextProbe}</strong>
      </div>
    </div>
    {probe?.result === 'fail' && <p className="probe-error">{probe.evidence}</p>}
    <div className="log-heading">
      <strong>Vercel {watch?.logsSource === 'deployment-events' ? 'deployment events' : 'runtime logs'}{deployment ? <span className="mono log-deployment">{shortDeployment(deployment.id)}</span> : null}</strong>
      <span>{watch?.logsCheckedAt ? `Updated ${formatTime(watch.logsCheckedAt)} · next ${nextLogs}` : 'Waiting for first log pull'}</span>
    </div>
    {watch?.logsSource === 'deployment-events' && <p className="log-fallback-note">Runtime logs are unavailable on this Vercel plan, so the build and deployment events of the same deployment are shown.</p>}
    {watch?.logsError && <p className="telemetry-error" role="status">{watch.logsError}</p>}
    {!watch && <p className="telemetry-empty">Live telemetry appears when the controller is running.</p>}
    {watch && !watch.logsError && logs.length === 0 && <p className="telemetry-empty">No runtime logs returned for the current deployment.</p>}
    {logs.length > 0 && <>
      {logs.some(log => crashLine(log)) && <div className="crash-highlight" role="status">
        <strong>Crash in these lines</strong>
        <ul>{logs.filter(log => crashLine(log)).slice(-8).map(log => <li key={`crash-${log.id}`}>{log.statusCode ? `HTTP ${log.statusCode} ` : ''}{log.message}</li>)}</ul>
      </div>}
      <ol className="runtime-logs">
      {logs.map(log => <li key={log.id} className={crashLine(log) ? 'runtime-log-error runtime-log-crash' : ''}>
        <time dateTime={new Date(log.timestamp).toISOString()}>{formatTime(new Date(log.timestamp).toISOString())}</time>
        <span className="runtime-log-level">{crashLine(log) ? 'crash' : log.level}</span>
        {log.statusCode !== undefined && <span className="runtime-log-status">HTTP {log.statusCode}</span>}
        <p>{log.message}</p>
      </li>)}
    </ol>
    </>}
  </section>;
}

function Overview({ watch }: { watch: WatchState | null }) {
  return <main className="detail overview">
    <div className="overview-hero">
      <h1>Production watch</h1>
      <p>Follow the latest health checks and deployment logs. Open an incident from the incident list to investigate its evidence and recovery.</p>
    </div>
    <WatchTelemetry watch={watch} />
  </main>;
}

function Detail({ incident, watch }: { incident: Incident; watch: WatchState | null }) {
  const actionLabel = waitingOnComment(incident) || incident.actionUrl?.includes('/issues/')
    ? 'Open GitHub issue'
    : incident.decision === 'fix_pr' ? 'Open pull request' : incident.decision === 'rollback' ? 'View rollback target' : 'View action';
  const detected = incident.events.find(event => event.type === 'detected');
  const decision = incident.events.find(event => event.type === 'decision');
  return <main className="detail">
    <div className="detail-heading">
      <div><p className="eyebrow">Incident {incident.id}</p><h1>{incident.cause ? incident.cause.replaceAll('_', ' ') : kindLabels[incident.kind]}</h1><p className="muted">Detected {formatDate(incident.detectedAt)} · {incident.projectId}</p><Link href="/">All incidents</Link></div>
      <StatusPill status={incident.status} />
    </div>
    <IssueReport incident={incident} />
    <section className="trigger" aria-label="What triggered this incident">
      <div>
        <span className="eyebrow">What triggered this</span>
        <h2>{detected?.message ?? incidentHeadline(incident)}</h2>
        <p>{incident.probePath ? `Probe ${incident.probePath}` : 'Deployment status check'}{incident.deploymentUrl ? ` on ${hostOf(incident.deploymentUrl)}` : ''}.</p>
      </div>
      <ul>
        {groupCopies(incident.evidence).map((item, index) => <li key={`${index}-${item.count}`}>
          <RichText text={item.text} />
          {item.count > 1 && <span className="repeat-count">repeated {item.count} times</span>}
        </li>)}
        {decision && <li><RichText text={decision.message} /></li>}
      </ul>
    </section>
    <section className="signal-grid" aria-label="Incident summary">
      <div><span>Cause</span><strong>{incident.cause ? incident.cause.replaceAll('_', ' ') : 'Not labeled yet'}</strong></div>
      <div><span>Decision</span><strong>{decisionSummary(incident)}</strong></div>
      <div><span>Revision</span><strong className="mono">{incident.commitSha ?? '—'}</strong></div>
      <div><span>Probe route</span><strong className="mono">{incident.probePath ?? 'Build status'}</strong></div>
      <div><span>Production host</span><strong className="mono">{hostOf(incident.deploymentUrl)}</strong></div>
      <div><span>Previous host</span><strong className="mono">{hostOf(incident.previousDeploymentUrl)}</strong></div>
      <div><span>Timeline</span><strong>{incident.events.length} events</strong></div>
    </section>
    <section className="action-banner">
      <div><span className="eyebrow">Current action</span><h2>{decisionSummary(incident)}</h2><p>{actionSummary(incident)}</p></div>
      {incident.actionUrl && <a className="action-link" href={incident.actionUrl} target="_blank" rel="noreferrer">{actionLabel}</a>}
    </section>
    {rolledBack(incident) && <ol className="rollback-steps">
      <li>Rollback — production moved back to the previous deploy.</li>
      <li>{incident.status === 'pr_opened' ? 'Fix — a pull request is open for that bad commit.' : waitingOnComment(incident) ? 'Fix — paused until a comment on the GitHub issue.' : incident.status === 'remediation_failed' ? 'Fix — the latest attempt failed; see the timeline for details.' : incident.status === 'needs_human' ? 'Fix — waiting for the next automatic attempt.' : 'Fix — the agent is working on the bad commit.'}</li>
    </ol>}
    {(incident.decision === 'rollback' || rolledBack(incident)) && <p className="caveat">{rollbackCaveat}</p>}
    <EscalationBanner incident={incident} />
    <WatchTelemetry watch={watch} />
    <RecoveryMetrics incident={incident} />
    <AffectedServices incident={incident} />
    <ActionAudit actions={incident.actions} />
    <Verification verification={incident.verification} />
    <LiveActivity incidentId={incident.id} />
    <div className="detail-columns"><EvidenceItems items={incident.evidenceItems} fallback={incident.evidence} /><Timeline events={incident.events} /></div>
  </main>;
}

type WatchState = {
  checkedAt: string | null;
  outcome: string;
  detail: string;
  probePath: string;
  intervalMs: number;
  logsIntervalMs?: number;
  failures?: number;
  rollbackEnabled?: boolean;
  probe: { checkedAt: string; result: 'pass' | 'fail' | 'unknown'; evidence: string; statusCode?: number } | null;
  logs: WatchLog[];
  logsCheckedAt: string | null;
  logsError: string | null;
  logsSource?: 'runtime-logs' | 'deployment-events' | null;
  deployment?: { id: string; url: string; createdAt: string } | null;
};

function checkLabel(watch: WatchState | null) {
  const failures = watch?.failures ?? 0;
  if (!watch || watch.outcome === 'starting') return 'Waiting for the first check';
  if (watch.outcome === 'healthy') return 'Production is up';
  if (watch.outcome === 'failing') return watch.failures == null ? 'Production is failing' : `Failing ${failures} of 3`;
  if (watch.outcome === 'incident') return 'Incident open';
  return 'Check did not finish';
}

function LiveWatch({ onWatch }: { onWatch?: (watch: WatchState) => void }) {
  const [clock, setClock] = useState(() => new Date());
  const [watch, setWatch] = useState<WatchState | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (mode === 'fixtures') return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch('/api/watch', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: abort.signal });
        if (response.ok) {
          const next = await response.json() as WatchState;
          setWatch(next);
          onWatch?.(next);
        }
      } catch { /* the next tick retries */ }
      if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, []);
  const checked = watch?.checkedAt ? new Date(watch.checkedAt) : null;
  const age = checked ? Math.max(0, Math.round((clock.getTime() - checked.getTime()) / 1000)) : null;
  const probeNext = nextIn(watch?.checkedAt, watch?.intervalMs ?? 30_000, clock);
  const logsNext = nextIn(watch?.logsCheckedAt, watch?.logsIntervalMs ?? 30_000, clock);
  const time = clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return <div className={`live-watch ${watch?.outcome ?? 'starting'}`} aria-live="polite">
    <strong className="live-clock">{time}</strong>
    {mode === 'fixtures'
      ? <span>Rehearsal data · local clock only</span>
      : <span>{checkLabel(watch)}{watch?.probePath ? ` · ${watch.probePath}` : ''}{age !== null ? ` · ${age}s ago` : ''}{watch?.checkedAt ? ` · next probe ${probeNext}` : ''}{watch?.logsCheckedAt ? ` · next logs ${logsNext}` : ''}</span>}
  </div>;
}

function FailureStreak({ watch }: { watch: WatchState | null }) {
  const known = typeof watch?.failures === 'number';
  const failures = watch?.outcome === 'healthy' ? 0 : Math.max(0, Math.min(watch?.failures ?? 0, 3));
  const note = !watch || watch.outcome === 'starting'
    ? 'Waiting for the first check.'
    : watch.outcome === 'incident'
      ? 'Three failures recorded. The incident is open.'
      : watch.outcome === 'unavailable'
        ? 'The last check did not finish.'
        : !known
          ? 'Failure count arrives after the controller redeploy.'
          : failures === 0
            ? 'Production passed. The streak is clear.'
            : `${failures} of 3 failures. The third starts the rollback or the fix.`;
  return <section className="streak" aria-label="Consecutive production failures">
    <div>
      <p className="eyebrow">Failure streak</p>
      <strong>{known || watch?.outcome === 'healthy' ? `${failures} / 3` : '—'}</strong>
      <span>{note}</span>
    </div>
    <ol>
      {[1, 2, 3].map(step => <li key={step} className={failures >= step ? 'hit' : ''}>
        <span>Fail {step}</span>
        <em>{failures >= step ? 'Failed' : 'Clear'}</em>
      </li>)}
    </ol>
  </section>;
}

function useTheme() {
  const [theme, setTheme] = useState<'night' | 'day'>(() => (typeof window !== 'undefined' && window.localStorage.getItem('sentinel-theme') === 'day' ? 'day' : 'night'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('sentinel-theme', theme);
  }, [theme]);
  return { theme, toggle: () => setTheme(value => (value === 'night' ? 'day' : 'night')) };
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [targetFilter, setTargetFilter] = useState('all');
  const selectedId = typeof params?.id === 'string' ? params.id : null;
  const { theme, toggle } = useTheme();
  const snapshot = useIncidents(mode, selectedId, refresh);
  const selected = snapshot.detail ?? snapshot.incidents.find(item => item.id === selectedId) ?? null;
  const targets = useMemo(() => [...new Set(snapshot.incidents.map(item => item.targetId).filter((value): value is string => Boolean(value)))], [snapshot.incidents]);
  const visible = useMemo(() => targetFilter === 'all' ? snapshot.incidents : snapshot.incidents.filter(item => item.targetId === targetFilter), [snapshot.incidents, targetFilter]);
  const counts = useMemo(() => ({ active: visible.filter(item => !['recovered', 'needs_human', 'remediation_failed', 'pr_opened'].includes(item.status)).length, recovered: visible.filter(item => item.status === 'recovered').length }), [visible]);
  const section = pathname.startsWith('/setup') ? 'setup' : pathname.startsWith('/watch') ? 'watch' : pathname.startsWith('/incidents/') ? 'incident' : pathname.startsWith('/incidents') ? 'incidents' : 'fleet';

  return <div className="app-shell">
    <header className="topbar">
      <Link className="brand" href="/"><img className="brand-logo" src="/logo.png" alt="" /><span>Sentinel</span></Link>
      <nav className="desk-nav" aria-label="Desk">
        <Link className={section === 'fleet' ? 'active' : ''} href="/">Sites</Link>
        <Link className={section === 'incidents' || section === 'incident' ? 'active' : ''} href="/incidents">Incidents</Link>
        <Link className={section === 'watch' ? 'active' : ''} href="/watch">Watch</Link>
        <Link className={section === 'setup' ? 'active' : ''} href="/setup">Setup</Link>
      </nav>
      <div className="topbar-meta">
        <LiveWatch onWatch={setWatch} />
        <span className={`mode-dot ${mode}`} />
        {mode === 'fixtures' ? 'Rehearsal' : 'Live'}
        <button className="refresh" onClick={() => setRefresh(value => value + 1)} type="button">Refresh</button>
        <button className="refresh theme-toggle" onClick={toggle} type="button" aria-label={theme === 'night' ? 'Switch to day mode' : 'Switch to night mode'}>{theme === 'night' ? 'Day' : 'Night'}</button>
        <button className="refresh" onClick={onLogout} type="button">Log out</button>
      </div>
    </header>
    {section === 'watch' && <><FailureStreak watch={watch} /><Overview watch={watch} /></>}
    {section === 'fleet' && <Fleet incidents={snapshot.incidents} />}
    {section === 'setup' && <Setup onClose={() => undefined} />}
    {section === 'incident' && <main className="detail-wrap">{selected ? <Detail incident={selected} watch={watch} /> : <p className="state-message">{snapshot.loading ? 'Loading this incident…' : 'That incident was not found.'} <Link href="/">Back to incidents</Link></p>}</main>}
    {section === 'incidents' && <main className="desk">
      <header className="desk-head">
        <div>
          <h1>Incidents</h1>
          <p>{counts.active} open · {counts.recovered} recovered · {visible.length} shown</p>
        </div>
        {targets.length > 1 && <label className="target-filter">Service
          <select value={targetFilter} onChange={event => setTargetFilter(event.target.value)}>
            <option value="all">All services</option>
            {targets.map(target => <option key={target} value={target}>{target}</option>)}
          </select>
        </label>}
      </header>
      {snapshot.loading && <p className="state-message">Loading incidents…</p>}
      {snapshot.error && <div className="error-box" role="alert"><strong>Controller unavailable</strong><p>{snapshot.error}</p><button onClick={() => setRefresh(value => value + 1)} type="button">Try again</button></div>}
      {!snapshot.loading && !snapshot.error && visible.length === 0 && <p className="desk-empty">Nothing is open. The probe keeps running on Watch.</p>}
      <nav className="incident-board" aria-label="Incidents">
        {visible.length > 0 && <div className="incident-row incident-row-head" aria-hidden="true"><span>State</span><span>What happened</span><span>Service</span><span>Detected</span></div>}
        {visible.map(incident => <IncidentCard key={incident.id} incident={incident} selected={false} onSelect={() => undefined} href={`/incidents/${incident.id}`} />)}
      </nav>
    </main>}
  </div>;
}

const watchedSites = [
  { name: 'Ledger', fault: 'Bad deploy', action: 'Restore the known-good revision', href: 'https://fieldnote-ledger.vercel.app' },
  { name: 'Switchboard', fault: 'Broken config', action: 'Restore BILLING_MODE to invoice', href: 'https://fieldnote-switchboard.vercel.app' },
  { name: 'Hopper', fault: 'Out of memory', action: 'Restart the task API once', href: 'https://fieldnote-hopper.vercel.app' },
  { name: 'Relay', fault: 'Dependency down', action: 'Restart the dependency, leave the app', href: 'https://fieldnote-relay.vercel.app' },
];

type FleetSite = {
  id: string;
  name: string;
  role: string;
  host: string;
  url: string;
  probePath: string;
  health: 'up' | 'down' | 'unknown';
  healthDetail: string;
  statusCode: number | null;
  openIncidents: number;
  latestIncidentId: string | null;
  errorTracking: string;
  trackersConnected: boolean;
};

function recentActivity(incident: Incident): number {
  return incident.events.reduce((latest, event) => Math.max(latest, Date.parse(event.at) || 0), Date.parse(incident.detectedAt) || 0);
}

/** The site card follows the incident that moved last, including one opened before a newer failed attempt. */
function latestSiteIncident(site: FleetSite, incidents: Incident[]): Incident | undefined {
  const related = incidents.filter(incident => {
    if (incident.status === 'recovered') return false;
    if (incident.targetId && incident.targetId === site.id) return true;
    return Boolean(site.host && incident.deploymentUrl?.includes(site.host));
  });
  return related.sort((left, right) => recentActivity(right) - recentActivity(left))[0];
}

function Fleet({ incidents }: { incidents: Incident[] }) {
  const [sites, setSites] = useState<FleetSite[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (mode === 'fixtures') return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch('/api/fleet', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: abort.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { sites?: FleetSite[] };
        setSites(body.sites ?? []);
        setError('');
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Fleet check failed.');
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 8000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, []);
  const shown = sites ?? watchedSites.map(site => ({
    id: site.name,
    name: site.name,
    role: site.name === 'Relay' ? 'dependency' : 'app',
    host: site.href.replace('https://', ''),
    url: site.href,
    probePath: '/api/tasks',
    health: 'unknown' as const,
    healthDetail: 'Waiting for the controller.',
    statusCode: null,
    openIncidents: incidents.filter(item => item.targetId?.includes(site.name.toLowerCase()) || item.deploymentUrl?.includes(site.href.replace('https://', ''))).length,
    latestIncidentId: null,
    errorTracking: 'Sentinel logs',
    trackersConnected: false,
  }));
  const down = shown.filter(site => site.health === 'down').length;
  const open = shown.reduce((sum, site) => sum + site.openIncidents, 0);
  return <main className="sites-page">
    <header className="desk-head">
      <div>
        <h1>{shown.length} connected sites</h1>
        <p>{down === 0 ? 'Every site answered the health check.' : `${down} site${down === 1 ? '' : 's'} failing the health check.`} {open} open incident{open === 1 ? '' : 's'} across the fleet.</p>
      </div>
      <Link className="button" href="/incidents">Incident list</Link>
    </header>
    {error && <p className="desk-empty" role="status">Live checks paused ({error}). The site list below stays visible.</p>}
    <ul className="site-grid fleet-grid">
      {shown.map(site => {
        const latest = latestSiteIncident(site, incidents);
        const incidentId = latest?.id ?? site.latestIncidentId;
        const pullRequest = latest?.status === 'pr_opened' && latest.actionUrl?.includes('/pull/') ? latest.actionUrl : undefined;
        return <li key={site.id}>
        <article className={`fleet-card fleet-${site.health}`}>
          <div className="fleet-card-top">
            <strong>{site.name}</strong>
            <span className={`health-pill health-${site.health}`}>{site.health === 'up' ? 'Healthy' : site.health === 'down' ? 'Errors' : 'Checking'}</span>
          </div>
          <p className="fleet-role">{site.role === 'dependency' ? 'Dependency' : 'Application'} · {site.host}</p>
          <dl>
            <div><dt>Health</dt><dd>{site.healthDetail}</dd></div>
            <div><dt>Error tracking</dt><dd>{site.openIncidents} open · {pullRequest ? 'Pull request open' : site.errorTracking}{site.trackersConnected ? '' : ' · Sentry and PostHog not connected'}</dd></div>
          </dl>
          <div className="fleet-actions">
            <a href={site.url} target="_blank" rel="noreferrer">Open site</a>
            {incidentId && <Link href={`/incidents/${incidentId}`}>Latest incident</Link>}
            {pullRequest && <a href={pullRequest} target="_blank" rel="noreferrer">Pull request</a>}
          </div>
        </article>
      </li>;
      })}
    </ul>
  </main>;
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) { setError('Invalid username or password.'); return; }
      onAuthenticated();
    } catch { setError('The controller is unavailable. Start it and try again.'); }
    finally { setBusy(false); }
  }

  return <main className="login-shell"><form className="login-card" onSubmit={submit}>
    <img className="login-logo" src="/logo.png" alt="Sentinel logo" /><p className="eyebrow">Sentinel deploy watch</p><h1>Sign in to the incident desk</h1>
    <p className="login-note">Use the local dashboard credentials configured in the controller environment.</p>
    <label>Username<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /></label>
    <label>Password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
    {error && <p className="login-error" role="alert">{error}</p>}
    <button className="action" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
  </form></main>;
}

function AuthenticatedApp() {
  const [authenticated, setAuthenticated] = useState(mode === 'fixtures' ? true : false);
  const [checking, setChecking] = useState(mode !== 'fixtures');
  useEffect(() => {
    if (mode === 'fixtures') return;
    void fetch('/api/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(response => { if (response.ok) setAuthenticated(true); })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);
  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* still leave the desk; the cookie clear is best-effort */ }
    setAuthenticated(false);
  }

  if (checking) return <main className="login-shell"><p className="muted">Checking dashboard session…</p></main>;
  return authenticated ? <Dashboard onLogout={() => void logout()} /> : <Login onAuthenticated={() => setAuthenticated(true)} />;
}

export default function App() {
  return <AuthenticatedApp />;
}
