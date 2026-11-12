export type TaskStatus = "Todo" | "In progress" | "Done";

export type Task = {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  owner: string;
  due: string;
};

export const tasks: Task[] = [
  {
    id: 1,
    title: "Review deployment health",
    description: "Confirm the latest deployment passes its health probe.",
    status: "In progress",
    owner: "Platform",
    due: "Today"
  },
  {
    id: 2,
    title: "Write regression test",
    description: "Add a test that catches the previously observed failure.",
    status: "Todo",
    owner: "Engineering",
    due: "Tomorrow"
  },
  {
    id: 3,
    title: "Document rollback procedure",
    description: "Record the recovery steps for the demo environment.",
    status: "Done",
    owner: "DevOps",
    due: "Yesterday"
  },
  {
    id: 4,
    title: "Verify incident report",
    description: "Check that evidence and action links are included.",
    status: "Todo",
    owner: "Platform",
    due: "Friday"
  }
];

export function getFaultMode(): "healthy" | "runtime" | "persistent" {
  const mode = process.env.DEMO_FAULT_MODE;
  if (mode === "runtime" || mode === "persistent") return mode;
  return "healthy";
}
