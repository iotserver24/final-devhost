import Link from "next/link";
import { projects } from "@/lib/projects";
import { tasks } from "@/lib/tasks";

export default function ProjectsPage() {
  return (
    <main>
      <section className="intro">
        <div>
          <p className="eyebrow">PROJECTS</p>
          <h1>Three live workstreams</h1>
          <p className="subtitle">Each project keeps its own tasks, owner, and due date.</p>
        </div>
      </section>
      <section className="project-grid">
        {projects.map((project) => {
          const count = tasks.filter((task) => task.projectId === project.id).length;
          return (
            <Link className="project-card" href={`/projects/${project.id}`} key={project.id}>
              <p className="card-project">{project.client}</p>
              <h2>{project.name}</h2>
              <p>{project.summary}</p>
              <span>{count} tasks</span>
            </Link>
          );
        })}
      </section>
    </main>
  );
}
