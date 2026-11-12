import { useEffect, useState } from 'react';
import { ApiError, fetchIncident, fetchIncidents } from './api';
import { fixtureIncidents } from './fixtures';
import type { Incident } from './incident';

export type DataMode = 'live' | 'fixtures';
interface Snapshot {
  mode: DataMode;
  incidents: Incident[];
  detail: Incident | null;
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
}
const initial = (mode: DataMode): Snapshot => ({ mode, incidents: [], detail: null, loading: true, error: null, updatedAt: null });

export function useIncidents(mode: DataMode, selectedId: string | null, refresh: number) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => initial(mode));
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(old => old.mode === mode
      ? { ...old, detail: !selectedId || old.detail?.id === selectedId ? old.detail : null, loading: true, error: null }
      : initial(mode));
    async function poll() {
      try {
        const incidents = mode === 'fixtures' ? fixtureIncidents : await fetchIncidents(abort.signal);
        const id = selectedId && incidents.some(item => item.id === selectedId) ? selectedId : incidents[0]?.id;
        const detail = id ? (mode === 'fixtures' ? incidents.find(item => item.id === id)! : await fetchIncident(id, abort.signal)) : null;
        if (!abort.signal.aborted) setSnapshot({ mode, incidents, detail, loading: false, error: null, updatedAt: new Date().toISOString() });
      } catch (error) {
        if (!abort.signal.aborted) setSnapshot(old => ({ ...(old.mode === mode ? old : initial(mode)), loading: false,
          error: error instanceof ApiError ? error.message : 'Incident data could not be loaded. Check the local controller.' }));
      } finally {
        if (!abort.signal.aborted && mode === 'live') timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [mode, selectedId, refresh]);
  return snapshot.mode === mode ? snapshot : initial(mode);
}
