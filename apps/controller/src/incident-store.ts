import postgres, { type Sql } from 'postgres';
import type { Incident } from '@nexathon/contracts';
import type { RuntimeLog } from './monitor';

interface StoredIncident { incident_json: Incident; }
export interface StoredAgentRun {
  id: string;
  incidentId: string;
  source: 'ai' | 'rehearsal';
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  outcome?: string;
  eventCount: number;
}

export interface StoredAgentEvent {
  seq: number;
  at: string;
  phase: string;
  kind: string;
  message: string;
}

interface MemoryState {
  incidents: Map<string, Incident>;
  probeStreaks: Map<string, { consecutiveFailures: number; firstFailureAt?: string }>;
  rollbackAttempts: Set<string>;
  settings: Map<string, string>;
  agentRuns: Map<string, StoredAgentRun & { events: StoredAgentEvent[] }>;
  runtimeLogs: Map<string, RuntimeLog & { projectId: string; deploymentId: string }>;
}
type StoreValue<T> = T | Promise<T>;

function storedIncident(value: unknown): Incident {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Stored incident is invalid.');
  return parsed as Incident;
}

function agentRunFromRow(row: Record<string, unknown>): StoredAgentRun {
  const run: StoredAgentRun = {
    id: String(row.id),
    incidentId: String(row.incident_id),
    source: row.source === 'rehearsal' ? 'rehearsal' : 'ai',
    status: ['queued', 'running', 'completed', 'failed'].includes(String(row.status)) ? row.status as StoredAgentRun['status'] : 'failed',
    startedAt: String(row.started_at),
    eventCount: Number(row.event_count),
  };
  if (row.finished_at) run.finishedAt = String(row.finished_at);
  if (row.outcome) run.outcome = String(row.outcome);
  return run;
}

function agentEventFromRow(row: Record<string, unknown>): StoredAgentEvent {
  return { seq: Number(row.seq), at: String(row.at), phase: String(row.phase), kind: String(row.kind), message: String(row.message) };
}

function memoryState(): MemoryState {
  return { incidents: new Map(), probeStreaks: new Map(), rollbackAttempts: new Set(), settings: new Map(), agentRuns: new Map(), runtimeLogs: new Map() };
}

export class IncidentStore {
  private readonly sql?: Sql;
  private readonly memory?: MemoryState;
  readonly ready: Promise<void>;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (connectionString === ':memory:') {
      this.memory = memoryState();
      this.ready = Promise.resolve();
      return;
    }
    if (!connectionString) throw new Error('DATABASE_URL is required; PostgreSQL replaces the former SQLite store.');
    this.sql = postgres(connectionString, {
      max: 5,
      idle_timeout: 20,
      max_lifetime: 60 * 30,
      connect_timeout: 30,
      keep_alive: 15,
    });
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.sql!`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        detected_at TEXT NOT NULL,
        incident_json JSONB NOT NULL
      )
    `;
    await this.sql!`CREATE INDEX IF NOT EXISTS incidents_detected_at_idx ON incidents (detected_at DESC)`;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS probe_streaks (
        project_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        probe_path TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        first_failure_at TEXT,
        PRIMARY KEY (project_id, deployment_id, probe_path)
      )
    `;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS rollback_attempts (
        deployment_id TEXT PRIMARY KEY,
        attempted_at TEXT NOT NULL
      )
    `;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS integration_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        event_count INTEGER NOT NULL
      )
    `;
    await this.sql!`CREATE INDEX IF NOT EXISTS agent_runs_started_at_idx ON agent_runs (started_at DESC)`;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS runtime_logs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        status_code INTEGER,
        logged_at BIGINT NOT NULL
      )
    `;
    await this.sql!`
      CREATE TABLE IF NOT EXISTS agent_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        phase TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      )
    `;
  }

  saveAgentRun(run: StoredAgentRun): StoreValue<void> {
    if (this.memory) {
      const current = this.memory.agentRuns.get(run.id);
      this.memory.agentRuns.set(run.id, { ...run, events: current?.events ?? [] });
      return;
    }
    return this.sql!`
      INSERT INTO agent_runs (id, incident_id, source, status, started_at, finished_at, outcome, event_count)
      VALUES (${run.id}, ${run.incidentId}, ${run.source}, ${run.status}, ${run.startedAt}, ${run.finishedAt ?? null}, ${run.outcome ?? null}, ${run.eventCount})
      ON CONFLICT(id) DO UPDATE SET
        status = EXCLUDED.status,
        finished_at = EXCLUDED.finished_at,
        outcome = EXCLUDED.outcome,
        event_count = EXCLUDED.event_count
    `.then(() => undefined);
  }

  saveAgentEvent(runId: string, event: StoredAgentEvent): StoreValue<void> {
    if (this.memory) {
      const run = this.memory.agentRuns.get(runId);
      if (!run) return;
      run.events = [...run.events.filter(item => item.seq !== event.seq), event].sort((a, b) => a.seq - b.seq).slice(-500);
      run.eventCount = run.events.length;
      return;
    }
    return this.sql!`
      INSERT INTO agent_events (run_id, seq, at, phase, kind, message)
      VALUES (${runId}, ${event.seq}, ${event.at}, ${event.phase}, ${event.kind}, ${event.message})
      ON CONFLICT(run_id, seq) DO UPDATE SET at = EXCLUDED.at, phase = EXCLUDED.phase, kind = EXCLUDED.kind, message = EXCLUDED.message
    `.then(async () => {
      if (event.seq > 500) await this.sql!`DELETE FROM agent_events WHERE run_id = ${runId} AND seq <= ${event.seq - 500}`;
    });
  }

  listAgentRuns(limit = 50): StoreValue<StoredAgentRun[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 50));
    if (this.memory) return [...this.memory.agentRuns.values()]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, bounded)
      .map(({ events: _events, ...run }) => run);
    return this.sql!`
      SELECT id, incident_id, source, status, started_at, finished_at, outcome, event_count
      FROM agent_runs ORDER BY started_at DESC LIMIT ${bounded}
    `.then(rows => rows.map(agentRunFromRow));
  }

  getAgentRun(id: string): StoreValue<(StoredAgentRun & { events: StoredAgentEvent[] }) | undefined> {
    if (this.memory) {
      const run = this.memory.agentRuns.get(id);
      return run ? { ...run, events: run.events.map(event => ({ ...event })) } : undefined;
    }
    return this.sql!`
      SELECT id, incident_id, source, status, started_at, finished_at, outcome, event_count
      FROM agent_runs WHERE id = ${id}
    `.then(async rows => {
      const row = rows[0];
      if (!row) return undefined;
      const events = await this.sql!`
        SELECT seq, at, phase, kind, message FROM agent_events WHERE run_id = ${id} ORDER BY seq ASC
      `;
      return { ...agentRunFromRow(row), events: events.map(agentEventFromRow) };
    });
  }

  save(incident: Incident): StoreValue<void> {
    if (this.memory) {
      this.memory.incidents.set(incident.id, structuredClone(incident));
      return;
    }
    return this.sql!`
      INSERT INTO incidents (id, detected_at, incident_json)
      VALUES (${incident.id}, ${incident.detectedAt}, ${this.sql!.json(incident as unknown as Record<string, never>)})
      ON CONFLICT(id) DO UPDATE SET detected_at = EXCLUDED.detected_at, incident_json = EXCLUDED.incident_json
    `.then(() => undefined);
  }

  get(id: string): StoreValue<Incident | undefined> {
    if (this.memory) return this.memory.incidents.has(id) ? structuredClone(this.memory.incidents.get(id)!) : undefined;
    return this.sql!`SELECT incident_json FROM incidents WHERE id = ${id}`
      .then(rows => {
        const value = (rows[0] as StoredIncident | undefined)?.incident_json;
        return value === undefined ? undefined : storedIncident(value);
      });
  }

  list(limit = 500): StoreValue<Incident[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    if (this.memory) return [...this.memory.incidents.values()]
      .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))
      .slice(0, boundedLimit)
      .map(incident => structuredClone(incident));
    return this.sql!`SELECT incident_json FROM incidents ORDER BY detected_at DESC LIMIT ${boundedLimit}`
      .then(rows => rows.map(row => storedIncident((row as StoredIncident).incident_json)));
  }

  recordProbe(
    projectId: string,
    deploymentId: string,
    probePath: string,
    result: 'pass' | 'fail' | 'unknown',
    at: string,
  ): StoreValue<{ consecutiveFailures: number; firstFailureAt?: string }> {
    const key = `${projectId}\0${deploymentId}\0${probePath}`;
    if (this.memory) {
      const current = this.memory.probeStreaks.get(key) ?? { consecutiveFailures: 0 };
      const next = result === 'fail'
        ? { consecutiveFailures: current.consecutiveFailures + 1, firstFailureAt: current.firstFailureAt ?? at }
        : { consecutiveFailures: 0 };
      this.memory.probeStreaks.set(key, next);
      return next;
    }
    const update = result === 'fail'
      ? this.sql!`
        INSERT INTO probe_streaks (project_id, deployment_id, probe_path, consecutive_failures, first_failure_at)
        VALUES (${projectId}, ${deploymentId}, ${probePath}, 1, ${at})
        ON CONFLICT(project_id, deployment_id, probe_path) DO UPDATE SET
          consecutive_failures = probe_streaks.consecutive_failures + 1,
          first_failure_at = COALESCE(probe_streaks.first_failure_at, EXCLUDED.first_failure_at)
      `
      : this.sql!`
        INSERT INTO probe_streaks (project_id, deployment_id, probe_path, consecutive_failures, first_failure_at)
        VALUES (${projectId}, ${deploymentId}, ${probePath}, 0, NULL)
        ON CONFLICT(project_id, deployment_id, probe_path) DO UPDATE SET consecutive_failures = 0, first_failure_at = NULL
      `;
    return update.then(async () => {
      const rows = await this.sql!`
        SELECT consecutive_failures, first_failure_at FROM probe_streaks
        WHERE project_id = ${projectId} AND deployment_id = ${deploymentId} AND probe_path = ${probePath}
      `;
      const row = rows[0] as { consecutive_failures: number; first_failure_at: string | null };
      return { consecutiveFailures: row.consecutive_failures, ...(row.first_failure_at ? { firstFailureAt: row.first_failure_at } : {}) };
    });
  }

  saveRuntimeLogs(projectId: string, deploymentId: string, logs: RuntimeLog[]): StoreValue<RuntimeLog[]> {
    const fresh: RuntimeLog[] = [];
    if (this.memory) {
      for (const log of logs) {
        if (this.memory.runtimeLogs.has(log.id)) continue;
        this.memory.runtimeLogs.set(log.id, { ...log, projectId, deploymentId });
        fresh.push(log);
      }
      const own = [...this.memory.runtimeLogs.entries()].filter(([, log]) => log.projectId === projectId);
      own.sort((a, b) => b[1].timestamp - a[1].timestamp).slice(200).forEach(([id]) => this.memory!.runtimeLogs.delete(id));
      return fresh;
    }
    return (async () => {
      for (const log of logs) {
        const rows = await this.sql!`
          INSERT INTO runtime_logs (id, project_id, deployment_id, level, message, status_code, logged_at)
          VALUES (${log.id}, ${projectId}, ${deploymentId}, ${log.level}, ${log.message}, ${log.statusCode ?? null}, ${log.timestamp})
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
        if (rows.length === 1) fresh.push(log);
      }
      await this.sql!`
        DELETE FROM runtime_logs WHERE project_id = ${projectId} AND id NOT IN (
          SELECT id FROM runtime_logs WHERE project_id = ${projectId} ORDER BY logged_at DESC LIMIT 200
        )
      `;
      return fresh;
    })();
  }

  claimRollback(deploymentId: string, at: string): StoreValue<boolean> {
    if (this.memory) {
      if (this.memory.rollbackAttempts.has(deploymentId)) return false;
      this.memory.rollbackAttempts.add(deploymentId);
      return true;
    }
    return this.sql!`
      INSERT INTO rollback_attempts (deployment_id, attempted_at)
      VALUES (${deploymentId}, ${at}) ON CONFLICT(deployment_id) DO NOTHING RETURNING deployment_id
    `.then(rows => rows.length === 1);
  }

  readSettings(): StoreValue<Record<string, string>> {
    if (this.memory) return Object.fromEntries(this.memory.settings);
    return this.sql!`SELECT key, value FROM integration_settings`
      .then(rows => Object.fromEntries(rows.map(row => [String(row.key), String(row.value)])));
  }

  writeSettings(values: Record<string, string>): StoreValue<void> {
    if (this.memory) {
      for (const [key, value] of Object.entries(values)) this.memory.settings.set(key, value);
      return;
    }
    return Promise.all(Object.entries(values).map(([key, value]) => this.sql!`
      INSERT INTO integration_settings (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `)).then(() => undefined);
  }

  deleteSettings(keys: string[]): StoreValue<void> {
    if (this.memory) {
      for (const key of keys) this.memory.settings.delete(key);
      return;
    }
    if (keys.length === 0) return;
    return Promise.all(keys.map(key => this.sql!`DELETE FROM integration_settings WHERE key = ${key}`)).then(() => undefined);
  }

  async close(): Promise<void> {
    await this.sql?.end({ timeout: 5 });
  }
}
