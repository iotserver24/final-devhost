export type Project = {
  id: string;
  name: string;
  summary: string;
  client: string;
};

export const projects: Project[] = [
  {
    id: "launch",
    name: "Launch checklist",
    summary: "Ship the public workspace without blocking the on-call rotation.",
    client: "Northwind"
  },
  {
    id: "onboarding",
    name: "Customer onboarding",
    summary: "Move a new workspace from invite to the first completed task.",
    client: "Harbor"
  },
  {
    id: "billing",
    name: "Billing follow-ups",
    summary: "Close invoices that are waiting on a person, not on code.",
    client: "Lumen"
  }
];

export function getProject(id: string): Project | undefined {
  return projects.find((project) => project.id === id);
}
