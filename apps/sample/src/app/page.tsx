"use client";

import { useCallback, useEffect, useState } from "react";
import type { Task, TaskStatus } from "@/lib/tasks";

const statusClass: Record<string, string> = {
  "Todo": "todo",
  "In progress": "progress",
  "Done": "done"
};

const STATUSES: TaskStatus[] = ["Todo", "In progress", "Done"];

type FaultMode = "healthy" | "runtime" | "persistent" | "dependency" | "ambiguous";

type ServiceProbe = {
  service: string;
  path: string;
  reachable: boolean;
  healthy: boolean;
  status: number | null;
  error: string | null;
  checkedAt: string | null;
};

type FaultState = {
  mode: FaultMode;
  source: "env" | "control";
  updatedAt: string;
};

type DryRunReport = {
  faultMode: string;
  probes: ServiceProbe[];
  outcome: { allowed: boolean; reason: string; targetChanged: boolean };
  evaluatedAt: string;
};

type TasksState =
  | { phase: "loading" }
  | { phase: "ready"; tasks: Task[] }
  | { phase: "error"; status: number | null; message: string };

const SERVICES: { service: string; path: string }[] = [
  { service: "health", path: "/api/health" },
  { service: "tasks", path: "/api/tasks" },
  { service: "summary", path: "/api/tasks/summary" }
];

const FAULT_MODES: { mode: FaultMode; label: string; hint: string }[] = [
  { mode: "runtime", label: "Runtime fault", hint: "health + tasks return HTTP 500" },
  { mode: "persistent", label: "Persistent fault", hint: "tasks returns HTTP 500 only" },
  { mode: "dependency", label: "Dependency fault", hint: "tasks returns HTTP 503, upstream store unreachable" },
  { mode: "ambiguous", label: "Ambiguous fault", hint: "unsafe: health and tasks disagree" }
];

async function probeServices(): Promise<ServiceProbe[]> {
  return Promise.all(
    SERVICES.map(async ({ service, path }) => {
      const checkedAt = new Date().toISOString();
      try {
        const response = await fetch(path, { cache: "no-store" });
        return {
          service,
          path,
          reachable: true,
          healthy: response.ok,
          status: response.status,
          error: response.ok ? null : `HTTP ${response.status}`,
          checkedAt
        };
      } catch (error) {
        return {
          service,
          path,
          reachable: false,
          healthy: false,
          status: null,
          error: error instanceof Error ? error.message : "Request failed",
          checkedAt
        };
      }
    })
  );
}

async function fetchTasks(): Promise<TasksState> {
  try {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
      return { phase: "error", status: response.status, message };
    }
    const tasks = Array.isArray((body as { tasks?: unknown })?.tasks)
      ? ((body as { tasks: Task[] }).tasks)
      : [];
    return { phase: "ready", tasks };
  } catch (error) {
    return {
      phase: "error",
      status: null,
      message: error instanceof Error ? error.message : "Task API unreachable"
    };
  }
}

export default function Home() {
  const [tasksState, setTasksState] = useState<TasksState>({ phase: "loading" });
  const [probes, setProbes] = useState<ServiceProbe[]>([]);
  const [faultState, setFaultState] = useState<FaultState | null>(null);
  const [pinnedByEnv, setPinnedByEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<DryRunReport | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [probeResults, faultResponse, tasksResult] = await Promise.all([
      probeServices(),
      fetch("/api/demo/faults", { cache: "no-store" }),
      fetchTasks()
    ]);
    setProbes(probeResults);
    setTasksState(tasksResult);
    if (faultResponse.ok) {
      const body = await faultResponse.json();
      setFaultState(body.state);
      setPinnedByEnv(Boolean(body.pinnedByEnv));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function callFaults(payload: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/demo/faults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? `Request failed (HTTP ${response.status})`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function runDryRun() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/demo/dry-run", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? `Dry run failed (HTTP ${response.status})`);
      } else {
        setDryRun(body.report);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dry run failed");
    } finally {
      setBusy(false);
    }
  }

  // Task mutations target the REST contracts BE1 is expected to provide.
  // Until those endpoints exist the API answers 404/405 and the UI shows it.
  async function mutateTask(request: Request): Promise<void> {
    setTaskBusy(true);
    setError(null);
    try {
      const response = await fetch(request);
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${response.status}`;
        setError(`Task operation failed: ${message}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Task API unreachable");
    } finally {
      setTaskBusy(false);
    }
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    await mutateTask(
      new Request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description: newDescription.trim(), status: "Todo" })
      })
    );
    setNewTitle("");
    setNewDescription("");
  }

  async function cycleStatus(task: Task) {
    const next = STATUSES[(STATUSES.indexOf(task.status) + 1) % STATUSES.length];
    await mutateTask(
      new Request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next })
      })
    );
  }

  async function deleteTask(task: Task) {
    await mutateTask(new Request(`/api/tasks/${task.id}`, { method: "DELETE" }));
  }

  const controlsDisabled = busy || pinnedByEnv;
  const tasks = tasksState.phase === "ready" ? tasksState.tasks : [];
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === "Done").length;
  const progress = tasks.filter((task) => task.status === "In progress").length;

  return (
    <main>
      <section className="intro">
        <div>
          <p className="eyebrow">BOARD</p>
          <h1>What the team is carrying</h1>
          <p className="subtitle">Live from the task API — {total} tasks on the board.</p>
        </div>
      </section>

      <section className="demo-panel" aria-label="Live service status and demo controls">
        <div className="panel-heading">
          <div>
            <h2>Service status</h2>
            <p>Live end-to-end probes against this app&apos;s own API routes.</p>
          </div>
          <button
            className="demo-button secondary"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Refresh now
          </button>
        </div>
        <div className="service-grid">
          {probes.length === 0 && <p className="demo-note">Probing services…</p>}
          {probes.map((probe) => (
            <article className="service-card" key={probe.service}>
              <div className="service-top">
                <span className={`service-dot ${probe.healthy ? "ok" : probe.reachable ? "fail" : "unknown"}`} />
                <span className="service-name">{probe.service}</span>
                <span className={`service-state ${probe.healthy ? "ok" : probe.reachable ? "fail" : "unknown"}`}>
                  {!probe.reachable ? "Unreachable" : probe.healthy ? "Healthy" : "Failing"}
                </span>
              </div>
              <div className="service-detail">GET {probe.path}</div>
              <div className="service-detail">
                Result: {probe.reachable ? `HTTP ${probe.status}` : `error — ${probe.error ?? "unknown"}`}
              </div>
              <div className="service-detail muted">
                Last check: {probe.checkedAt ?? "—"}
              </div>
            </article>
          ))}
        </div>

        <div className="controls-heading">
          <div>
            <h2>Demo controls <span className="demo-badge">local only</span></h2>
            <p>
              Fault injection for this demo target. Current mode:{" "}
              <strong>{faultState ? faultState.mode : "unknown"}</strong>
              {faultState?.source === "env" ? " (pinned by DEMO_FAULT_MODE)" : ""}.
            </p>
          </div>
        </div>
        <div className="controls-row">
          {FAULT_MODES.map(({ mode, label, hint }) => (
            <button
              key={mode}
              className={`demo-button ${faultState?.mode === mode ? "active" : ""}`}
              onClick={() => void callFaults({ action: "set", mode })}
              disabled={controlsDisabled}
              title={hint}
            >
              {label}
            </button>
          ))}
          <button
            className="demo-button danger"
            onClick={() => void callFaults({ action: "reset" })}
            disabled={controlsDisabled}
          >
            Reset demo
          </button>
          <button
            className="demo-button dryrun"
            onClick={() => void runDryRun()}
            disabled={controlsDisabled}
          >
            Dry run (no target change)
          </button>
        </div>
        {pinnedByEnv && (
          <p className="demo-note">DEMO_FAULT_MODE is set in the environment; demo controls are disabled until it is unset.</p>
        )}
        {busy && <p className="demo-note">Operation in progress…</p>}
        {error && <p className="demo-error" role="alert">{error}</p>}

        {dryRun && (
          <div className="dryrun-report">
            <h3>Dry-run report (target unchanged: {String(dryRun.outcome.targetChanged)})</h3>
            <p className="demo-note">
              Fault mode at evaluation: <strong>{dryRun.faultMode}</strong> · evaluated{" "}
              {dryRun.evaluatedAt}
            </p>
            <ul>
              {dryRun.probes.map((probe) => (
                <li key={probe.service}>
                  {probe.service}:{" "}
                  {!probe.reachable
                    ? "unreachable"
                    : probe.healthy
                      ? `healthy (HTTP ${probe.status})`
                      : `failing (HTTP ${probe.status})`}
                </li>
              ))}
            </ul>
            <p>
              Policy decision: <strong>{dryRun.outcome.allowed ? "allowed" : "blocked"}</strong> —{" "}
              {dryRun.outcome.reason}
            </p>
          </div>
        )}
      </section>

      <section className="stats" aria-label="Task summary">
        <article className="stat-card">
          <div className="stat-top"><span className="stat-icon lavender">▤</span><span className="stat-label">Open</span></div>
          <div className="stat-number">{total - done}</div>
          <div className="stat-foot">Still on the board</div>
        </article>
        <article className="stat-card">
          <div className="stat-top"><span className="stat-icon amber">◷</span><span className="stat-label">In progress</span></div>
          <div className="stat-number">{progress}</div>
          <div className="stat-foot">Someone is on these</div>
        </article>
        <article className="stat-card">
          <div className="stat-top"><span className="stat-icon mint">✓</span><span className="stat-label">Done</span></div>
          <div className="stat-number">{done}</div>
          <div className="stat-foot">Finished this cycle</div>
        </article>
      </section>

      <section className="tasks-panel">
        <div className="panel-heading">
          <div><h2>Team tasks</h2><p>Live from GET /api/tasks.</p></div>
          <span className="task-count">{total} tasks</span>
        </div>

        <form className="task-form" onSubmit={createTask}>
          <input
            className="task-input"
            placeholder="New task title"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            disabled={taskBusy}
            aria-label="New task title"
          />
          <input
            className="task-input"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
            disabled={taskBusy}
            aria-label="New task description"
          />
          <button className="demo-button" type="submit" disabled={taskBusy || !newTitle.trim()}>
            Add task
          </button>
        </form>

        <div className="task-list">
          {tasksState.phase === "loading" && <p className="demo-note tasks-state">Loading tasks…</p>}
          {tasksState.phase === "error" && (
            <div className="tasks-state tasks-error" role="alert">
              <p>
                Could not load tasks{" "}
                {tasksState.status !== null ? `(HTTP ${tasksState.status})` : "(API unreachable)"}:{" "}
                {tasksState.message}
              </p>
              <button className="demo-button secondary" onClick={() => void refresh()} disabled={busy}>
                Retry
              </button>
            </div>
          )}
          {tasksState.phase === "ready" && tasks.length === 0 && (
            <p className="demo-note tasks-state">No tasks yet — add one above.</p>
          )}
          {tasksState.phase === "ready" &&
            tasks.map((task) => (
              <article className="task-row" key={task.id}>
                <div className={`task-check ${task.status === "Done" ? "checked" : ""}`}>
                  {task.status === "Done" ? "✓" : ""}
                </div>
                <div className="task-main">
                  <h3>{task.title}</h3>
                  <p>{task.description}</p>
                </div>
                <button
                  className={`status ${statusClass[task.status]}`}
                  onClick={() => void cycleStatus(task)}
                  disabled={taskBusy}
                  title="Click to change status"
                >
                  {task.status}
                </button>
                <span className="task-owner">{task.owner}</span>
                <span className="task-due">{task.due}</span>
                <button
                  className="task-delete"
                  onClick={() => void deleteTask(task)}
                  disabled={taskBusy}
                  title="Delete task"
                  aria-label={`Delete ${task.title}`}
                >
                  ✕
                </button>
              </article>
            ))}
        </div>
        <div className="panel-footer">
          <span><span className="footer-dot" /> Task list is fetched from the task API on every refresh</span>
          <span>Demo workspace · v1</span>
        </div>
      </section>
    </main>
  );
}
