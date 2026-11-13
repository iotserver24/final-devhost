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

export const TASK_STATUSES: TaskStatus[] = ["Todo", "In progress", "Done"];

export type CreateTaskInput = {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  owner?: unknown;
  due?: unknown;
};

export function createTask(input: CreateTaskInput): Task {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new ValidationError("title is required");
  }
  if (input.title.length > 200) {
    throw new ValidationError("title must be at most 200 characters");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new ValidationError("description must be a string");
  }
  const status = input.status === undefined ? "Todo" : input.status;
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new ValidationError(`status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  const id = tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1;
  const task: Task = {
    id,
    projectId: "launch",
    title: input.title.trim(),
    description: typeof input.description === "string" ? input.description : "",
    status: status as TaskStatus,
    owner: typeof input.owner === "string" && input.owner.trim() ? input.owner.trim() : "Platform",
    due: typeof input.due === "string" && input.due.trim() ? input.due.trim() : "Today"
  };
  tasks.push(task);
  return task;
}

export type UpdateTaskInput = {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  owner?: unknown;
  due?: unknown;
};

export function updateTask(id: number, input: UpdateTaskInput): Task | undefined {
  const task = getTask(id);
  if (!task) return undefined;
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      throw new ValidationError("title must be a non-empty string");
    }
    task.title = input.title.trim();
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string") throw new ValidationError("description must be a string");
    task.description = input.description;
  }
  if (input.status !== undefined) {
    if (!TASK_STATUSES.includes(input.status as TaskStatus)) {
      throw new ValidationError(`status must be one of: ${TASK_STATUSES.join(", ")}`);
    }
    task.status = input.status as TaskStatus;
  }
  if (input.owner !== undefined) {
    if (typeof input.owner !== "string") throw new ValidationError("owner must be a string");
    task.owner = input.owner;
  }
  if (input.due !== undefined) {
    if (typeof input.due !== "string") throw new ValidationError("due must be a string");
    task.due = input.due;
  }
  return task;
}

export function deleteTask(id: number): boolean {
  const index = tasks.findIndex((task) => task.id === id);
  if (index === -1) return false;
  tasks.splice(index, 1);
  return true;
}

export class ValidationError extends Error {}

export { getFaultMode } from "@/lib/faults";
