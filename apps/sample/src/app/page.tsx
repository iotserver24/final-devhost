import Link from "next/link";
import { getProject } from "@/lib/projects";
import { tasks, type TaskStatus } from "@/lib/tasks";

const columns: TaskStatus[] = ["Todo", "In progress", "Done"];

export default function Home() {
  const done = tasks.filter((task) => task.status === "Done").length;
  const progress = tasks.filter((task) => task.status === "In progress").length;

  return (
    <main>
      <section className="intro">
        <div>
          <p className="eyebrow">BOARD</p>
          <h1>What the team is carrying</h1>
          <p className="subtitle">{tasks.length} tasks across launch, onboarding, and billing.</p>
        </div>
        <Link className="button" href="/projects">Open projects</Link>
      </section>

      <section className="stats" aria-label="Task summary">
        <article className="stat-card">
          <div className="stat-top"><span className="stat-icon lavender">▤</span><span className="stat-label">Open</span></div>
          <div className="stat-number">{tasks.length - done}</div>
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

      <section className="board" aria-label="Task board">
        {columns.map((status) => {
          const column = tasks.filter((task) => task.status === status);
          return (
            <div className="column" key={status}>
              <header>
                <h2>{status}</h2>
                <span>{column.length}</span>
              </header>
              {column.map((task) => {
                const project = getProject(task.projectId);
                return (
                  <Link className="card" href={`/tasks/${task.id}`} key={task.id}>
                    <p className="card-project">{project?.name}</p>
                    <h3>{task.title}</h3>
                    <p>{task.owner} · {task.due}</p>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </section>
    </main>
  );
}
