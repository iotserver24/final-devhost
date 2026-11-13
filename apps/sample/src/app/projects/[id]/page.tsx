import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject, projects } from "@/lib/projects";
import { tasks } from "@/lib/tasks";

export function generateStaticParams() {
  return projects.map((project) => ({ id: project.id }));
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) notFound();
  const related = tasks.filter((task) => task.projectId === project.id);

  return (
    <main>
      <section className="intro">
        <div>
          <p className="eyebrow">{project.client.toUpperCase()}</p>
          <h1>{project.name}</h1>
          <p className="subtitle">{project.summary}</p>
        </div>
        <Link className="button" href="/projects">All projects</Link>
      </section>
      <section className="tasks-panel">
        <div className="panel-heading">
          <div><h2>Tasks</h2><p>{related.length} in this project</p></div>
        </div>
        <div className="task-list">
          {related.map((task) => (
            <Link className="task-row task-link" href={`/tasks/${task.id}`} key={task.id}>
              <div className={`task-check ${task.status === "Done" ? "checked" : ""}`}>{task.status === "Done" ? "✓" : ""}</div>
              <div className="task-main">
                <h3>{task.title}</h3>
                <p>{task.description}</p>
              </div>
              <span className={`status ${task.status === "In progress" ? "progress" : task.status.toLowerCase()}`}>{task.status}</span>
              <span className="task-owner">{task.owner}</span>
              <span className="task-due">{task.due}</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
