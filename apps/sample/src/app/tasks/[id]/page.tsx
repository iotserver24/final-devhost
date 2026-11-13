import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/lib/projects";
import { getTask, tasks } from "@/lib/tasks";

export function generateStaticParams() {
  return tasks.map((task) => ({ id: String(task.id) }));
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(Number(id));
  if (!task || !Number.isInteger(Number(id))) notFound();
  const project = getProject(task.projectId);

  return (
    <main>
      <section className="intro">
        <div>
          <p className="eyebrow">TASK</p>
          <h1>{task.title}</h1>
          <p className="subtitle">{task.description}</p>
        </div>
        <Link className="button" href={project ? `/projects/${project.id}` : "/"}>Back to project</Link>
      </section>
      <section className="detail">
        <div><span>Status</span><strong>{task.status}</strong></div>
        <div><span>Owner</span><strong>{task.owner}</strong></div>
        <div><span>Due</span><strong>{task.due}</strong></div>
        <div><span>Project</span><strong>{project ? <Link href={`/projects/${project.id}`}>{project.name}</Link> : "Unknown"}</strong></div>
      </section>
    </main>
  );
}
