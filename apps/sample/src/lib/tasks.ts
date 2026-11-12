export type TaskStatus = "Todo" | "In progress" | "Done";

export type Task = {
  id: number;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  owner: string;
  due: string;
};

export const tasks: Task[] = [
  {
    id: 1,
    projectId: "launch",
    title: "Confirm production health",
    description: "Open the public task list and confirm it returns the workspace tasks.",
    status: "In progress",
    owner: "Ava",
    due: "Today"
  },
  {
    id: 2,
    projectId: "launch",
    title: "Publish the status guide",
    description: "Tell the team how Todo, In progress, and Done are used on the board.",
    status: "Todo",
    owner: "Noah",
    due: "Tomorrow"
  },
  {
    id: 3,
    projectId: "onboarding",
    title: "Send the Harbor invite",
    description: "Harbor's admin is waiting for access to the shared board.",
    status: "Done",
    owner: "Mia",
    due: "Yesterday"
  },
  {
    id: 4,
    projectId: "billing",
    title: "Match the March invoice",
    description: "Lumen paid the invoice. Attach the receipt to the billing project.",
    status: "Todo",
    owner: "Ava",
    due: "Friday"
  },
  {
    id: 5,
    projectId: "onboarding",
    title: "Import Harbor's first tasks",
    description: "Copy the kickoff list into the onboarding project.",
    status: "In progress",
    owner: "Leo",
    due: "Today"
  },
  {
    id: 6,
    projectId: "billing",
    title: "Ask Lumen about the tax line",
    description: "The invoice total does not match the signed order.",
    status: "Todo",
    owner: "Noah",
    due: "Monday"
  },
  {
    id: 7,
    projectId: "launch",
    title: "Review the empty-board state",
    description: "A new project with no tasks should explain what to add.",
    status: "Todo",
    owner: "Mia",
    due: "Wednesday"
  }
];

export function getTask(id: number): Task | undefined {
  return tasks.find((task) => task.id === id);
}

export function getFaultMode(): "healthy" | "runtime" | "persistent" {
  const mode = process.env.DEMO_FAULT_MODE;
  if (mode === "runtime" || mode === "persistent") return mode;
  return "healthy";
}
