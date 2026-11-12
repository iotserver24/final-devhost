import { useEffect, useRef, useState } from 'react';
import { ApiError, readJson } from './api';
import { parseActivityDetail, parseActivityEvent, parseActivityRuns, type ActivityEvent, type ActivityRun } from './activity';
import type { DataMode } from './useIncidents';

const POLL_MS = 1500;
const MAX_EVENTS = 500;

export interface ActivitySnapshot {
  run: ActivityRun | null;
  runs: ActivityRun[];
  events: ActivityEvent[];
  error: string | null;
}

/** Watches the newest controller run for this incident and streams its live events. */
export function useActivity(mode: DataMode, incidentId: string | null, selectedRunId = ''): ActivitySnapshot {
  const [runs, setRuns] = useState<ActivityRun[]>([]);
  const [run, setRun] = useState<ActivityRun | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loadedRun = useRef<string | null>(null);
  const status = useRef<ActivityRun['status'] | undefined>(undefined);
  status.current = run?.status;

  useEffect(() => {
    if (mode !== 'live') return;
    const abort = new AbortController();
    loadedRun.current = null;
    setRun(null);
    setEvents([]);
    setRuns([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const runs = parseActivityRuns(await readJson('/api/agent/runs', abort.signal));
        if (abort.signal.aborted) return;
        const matching = runs.filter(candidate => candidate.incidentId === incidentId);
        setRuns(matching);
        const match = (selectedRunId ? matching.find(candidate => candidate.id === selectedRunId) : matching[0]) ?? null;
        setRun(match);
        if (match) {
          if (loadedRun.current !== match.id) { loadedRun.current = match.id; setEvents([]); }
          const detail = parseActivityDetail(await readJson(`/api/agent/runs/${match.id}`, abort.signal));
          if (!abort.signal.aborted && loadedRun.current === match.id) setEvents(current => {
            const merged = new Map(current.map(event => [event.seq, event]));
            for (const event of detail.events) if (!merged.has(event.seq)) merged.set(event.seq, event);
            return [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS);
          });
        } else setEvents([]);
        setError(null);
      } catch (failure) {
        if (abort.signal.aborted) return;
        setError(failure instanceof ApiError ? failure.message : 'Agent activity could not be loaded.');
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, POLL_MS);
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [mode, incidentId, selectedRunId]);

  const runId = run?.id;

  useEffect(() => {
    if (mode !== 'live' || !runId || status.current === 'completed' || status.current === 'failed') return;
    let closed = false;
    const source = new EventSource(`/api/agent/runs/${runId}/events`);
    source.addEventListener('activity', (message) => {
      if (closed) return;
      let payload: unknown;
      try { payload = JSON.parse((message as MessageEvent<string>).data); } catch { return; }
      const event = parseActivityEvent(payload);
      if (!event) return;
      setEvents(current => [...current.filter(item => item.seq !== event.seq), event].sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS));
    });
    source.addEventListener('done', () => { closed = true; source.close(); });
    source.onerror = () => {
      if (closed) return;
      // A finished run closes the stream on purpose; only report an unexpected drop.
      if (status.current === 'completed' || status.current === 'failed') { source.close(); return; }
      setError('The live activity stream dropped while the run was still active.');
    };
    return () => { closed = true; source.close(); };
  }, [mode, runId]);

  return { run, runs, events, error };
}
