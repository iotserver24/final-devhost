import { redact, redactFull } from '@nexathon/notifier/format';

export const activityPhases = [
  'sandbox',
  'checkout',
  'setup',
  'reproduction',
  'agent',
  'verification',
  'patch',
] as const;

export type ActivityPhase = (typeof activityPhases)[number];
export type ActivityStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ActivityEvent {
  seq: number;
  at: string;
  phase: ActivityPhase;
  kind: 'stage' | 'tool' | 'tool_input' | 'tool_output' | 'summary' | 'message' | 'usage' | 'status';
  message: string;
}

export interface ActivityRun {
  id: string;
  incidentId: string;
  source: 'ai' | 'rehearsal';
  status: ActivityStatus;
  startedAt: string;
  finishedAt?: string;
  outcome?: string;
  eventCount: number;
}

const kinds = ['stage', 'tool', 'tool_input', 'tool_output', 'summary', 'message', 'usage', 'status'];
const sources = ['ai', 'rehearsal'];
const statuses = ['queued', 'running', 'completed', 'failed'];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid activity response.');
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10_000) throw new Error('Invalid activity field.');
  return redact(value, max);
}

function date(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid activity timestamp.');
  return value;
}

export function parseActivityRun(value: unknown): ActivityRun {
  const item = record(value);
  if (!sources.includes(String(item.source)) || !statuses.includes(String(item.status))) throw new Error('Invalid activity run state.');
  if (!Number.isSafeInteger(item.eventCount) || (item.eventCount as number) < 0) throw new Error('Invalid activity event count.');
  const run: ActivityRun = {
    id: text(item.id, 64),
    incidentId: text(item.incidentId, 64),
    source: item.source as ActivityRun['source'],
    status: item.status as ActivityStatus,
    startedAt: date(item.startedAt),
    eventCount: item.eventCount as number,
  };
  if (item.finishedAt !== undefined) run.finishedAt = date(item.finishedAt);
  if (item.outcome !== undefined) run.outcome = text(item.outcome, 300);
  return run;
}

export function parseActivityDetail(value: unknown): { run: ActivityRun; events: ActivityEvent[] } {
  const run = parseActivityRun(value);
  const item = record(value);
  if (!Array.isArray(item.events) || item.events.length > 500) throw new Error('Invalid activity events.');
  return { run, events: item.events.flatMap(event => { const parsed = parseActivityEvent(event); return parsed ? [parsed] : []; }) };
}

export function parseActivityRuns(value: unknown): ActivityRun[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Expected at most 50 activity runs.');
  return value.map(parseActivityRun);
}

/** Returns null for events the dashboard should ignore rather than fail on. */
export function parseActivityEvent(value: unknown): ActivityEvent | null {
  let item: Record<string, unknown>;
  try { item = record(value); } catch { return null; }
  if (!Number.isSafeInteger(item.seq) || (item.seq as number) < 1) return null;
  if (!activityPhases.includes(item.phase as ActivityPhase) || !kinds.includes(String(item.kind))) return null;
  try {
    return {
      seq: item.seq as number,
      at: date(item.at),
      phase: item.phase as ActivityPhase,
      kind: item.kind as ActivityEvent['kind'],
      message: typeof item.message === 'string' && item.message.trim() && item.message.length <= 32_000
        ? redactFull(item.message) : text(item.message),
    };
  } catch { return null; }
}
