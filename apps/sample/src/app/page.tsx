import Link from "next/link";
import { tasks } from "@/lib/tasks";

const statusClass: Record<string, string> = {
  "Todo": "todo",
  "In progress": "progress",
  "Done": "done"
};

export default function Home() {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === "Done").length;
  const progress = tasks.filter((task) => task.status === "In progress").length;

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="TaskFlow home">
          <span className="brand-mark">T</span>
          <span>TaskFlow<span className="brand-dot">.</span></span>
        </Link>
        <div className="topbar-right">
          <span className="environment"><span className="pulse" /> Sample environment</span>
          <div className="avatar" aria-label="Platform team">PT</div>
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">WORKSPACE / OVERVIEW</p>
          <h1>Good morning, team <span>✳</span></h1>
          <p className="subtitle">A clear view of what needs to get done.</p>
        </div>
        <a className="button" href="/api/tasks" target="_blank" rel="noreferrer">
          View API response <span aria-hidden="true">↗</span>
        </a>
      </section>

      <section className="stats" aria-label="Task summary">
        <article className="stat-card">
          <div className="stat-top"><span className="stat-icon lavender">▤</span><span className="stat-label">All tasks</span></div>
          <div className="stat-number">{total}</div>
          <div className="stat-foot">Across your workspace</div>
        </article>
        <article className="stat-card">
          <div className="stat-top"><span className="stat-icon amber">◷</span><span className="stat-label">In progress</span></div>
          <div className="stat-number">{progress}</div>
          <div className="stat-foot">Currently being worked on</div>
        </article>
        <article className="stat-card">
          <div className="stat-top"><span className="stat-icon mint">✓</span><span className="stat-label">Completed</span></div>
          <div className="stat-number">{done}</div>
          <div className="stat-foot">Nice work, keep it up</div>
        </article>
      </section>

      <section className="tasks-panel">
        <div className="panel-heading">
          <div><h2>Team tasks</h2><p>Your team&apos;s latest work at a glance.</p></div>
          <span className="task-count">{total} tasks</span>
        </div>
        <div className="task-list">
          {tasks.map((task) => (
            <article className="task-row" key={task.id}>
              <div className={`task-check ${task.status === "Done" ? "checked" : ""}`}>
                {task.status === "Done" ? "✓" : ""}
              </div>
              <div className="task-main">
                <h3>{task.title}</h3>
                <p>{task.description}</p>
              </div>
              <span className={`status ${statusClass[task.status]}`}>{task.status}</span>
              <span className="task-owner">{task.owner}</span>
              <span className="task-due">{task.due}</span>
            </article>
          ))}
        </div>
        <div className="panel-footer">
          <span><span className="footer-dot" /> All sample data is local to this app</span>
          <span>Demo workspace · v1</span>
        </div>
      </section>

      <footer className="page-footer">
        <span>Built for <strong>Nexathon</strong></span>
        <span>TaskFlow sample target · <a href="/api/health">Health check</a> · <a href="/api/tasks/summary">API summary</a></span>
      </footer>
    </main>
  );
}
