import { redactFull } from '@nexathon/notifier/format';
import { boundActivityText } from '@nexathon/remediator';
import type { RemediationActivity } from '@nexathon/remediator';

export type ActivitySource = 'ai' | 'rehearsal';
export type ActivityStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ActivityEvent extends RemediationActivity {
  seq: number;
}

export interface ActivityRunSummary {
  id: string;
  incidentId: string;
  source: ActivitySource;
  status: ActivityStatus;
  startedAt: string;
  finishedAt?: string;
  outcome?: string;
  eventCount: number;
}

export interface ActivityRunDetail extends ActivityRunSummary {
  events: ActivityEvent[];
}

const MAX_RUNS = 20;
const MAX_EVENTS = 500;
const MAX_SUBSCRIBERS = 25;

interface StoredRun {
  id: string;
  incidentId: string;
  source: ActivitySource;
  status: ActivityStatus;
  startedAt: string;
  finishedAt?: string;
  outcome?: string;
  events: ActivityEvent[];
  subscribers: Set<(event: ActivityEvent) => void>;
  nextSeq: number;
}

function summary(run: StoredRun): ActivityRunSummary {
  return {
    id: run.id,
    incidentId: run.incidentId,
    source: run.source,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.outcome ? { outcome: run.outcome } : {}),
    eventCount: run.events.length,
  };
}

export interface ActivityPersistence {
  saveRun(run: ActivityRunSummary): void;
  saveEvent(runId: string, event: ActivityEvent): void;
}

/**
 * Live feed of remediation progress. Events contain redacted public messages and tool details produced by the
 * remediator. When a persistence sink is provided, each run and event is written
 * there so a later process can show the log after the sandbox is gone.
 */
export class ActivityHub {
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly persist?: ActivityPersistence) {}

  /** Loads a previously stored run without writing it again. */
  restore(detail: ActivityRunDetail): void {
    if (this.runs.has(detail.id)) return;
    const events = detail.events.slice(-MAX_EVENTS);
    this.runs.set(detail.id, {
      id: detail.id,
      incidentId: detail.incidentId,
      source: detail.source,
      status: detail.status,
      startedAt: detail.startedAt,
      ...(detail.finishedAt ? { finishedAt: detail.finishedAt } : {}),
      ...(detail.outcome ? { outcome: detail.outcome } : {}),
      events,
      subscribers: new Set(),
      nextSeq: events.reduce((max, event) => Math.max(max, event.seq), 0) + 1,
    });
  }

  create(input: { incidentId: string; source: ActivitySource }): ActivityRunSummary {
    const run: StoredRun = {
      id: `run-${crypto.randomUUID().slice(0, 12)}`,
      incidentId: input.incidentId,
      source: input.source,
      status: 'queued',
      startedAt: new Date().toISOString(),
      events: [],
      subscribers: new Set(),
      nextSeq: 1,
    };
    this.runs.set(run.id, run);
    this.persist?.saveRun(summary(run));
    for (const [id, candidate] of this.runs) {
      if (this.runs.size <= MAX_RUNS) break;
      if (candidate.subscribers.size === 0) this.runs.delete(id);
    }
    return summary(run);
  }

  markRunning(id: string): void {
    const run = this.runs.get(id);
    if (run && run.status === 'queued') {
      run.status = 'running';
      this.persist?.saveRun(summary(run));
    }
  }

  append(id: string, activity: RemediationActivity): void {
    const run = this.runs.get(id);
    if (!run) return;
    const event: ActivityEvent = {
      seq: run.nextSeq++,
      at: activity.at,
      phase: activity.phase,
      kind: activity.kind,
      message: boundActivityText(redactFull(activity.message)),
    };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.shift();
    this.persist?.saveEvent(run.id, event);
    this.persist?.saveRun(summary(run));
    for (const subscriber of run.subscribers) {
      try {
        subscriber(event);
      } catch {
        run.subscribers.delete(subscriber);
      }
    }
  }

  finish(id: string, status: Exclude<ActivityStatus, 'queued' | 'running'>, outcome: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.outcome = outcome.slice(0, 300);
    this.persist?.saveRun(summary(run));
    this.append(id, { at: run.finishedAt, phase: 'patch', kind: 'status', message: run.outcome });
    for (const subscriber of run.subscribers) run.subscribers.delete(subscriber);
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  statusOf(id: string): ActivityStatus | undefined {
    return this.runs.get(id)?.status;
  }

  hasActiveRun(): boolean {
    for (const run of this.runs.values()) {
      if (run.status === 'queued' || run.status === 'running') return true;
    }
    return false;
  }

  list(): ActivityRunSummary[] {
    return [...this.runs.values()].reverse().map(summary);
  }

  get(id: string, afterSeq = 0): ActivityRunDetail | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    return { ...summary(run), events: run.events.filter(event => event.seq > afterSeq) };
  }

  /** Replays events after `afterSeq`, then streams new ones. Returns undefined for unknown runs. */
  subscribe(id: string, afterSeq: number, listener: (event: ActivityEvent) => void): (() => void) | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.subscribers.size >= MAX_SUBSCRIBERS) return undefined;
    for (const event of run.events) if (event.seq > afterSeq) listener(event);
    run.subscribers.add(listener);
    return () => run.subscribers.delete(listener);
  }
}
