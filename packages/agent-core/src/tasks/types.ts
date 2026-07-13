import { AgentLoopEvent } from '../agents/AgentLoop.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'dead_letter';

export interface Task {
  id: string;
  threadId?: string;
  message: string;
  status: TaskStatus;
  reply?: string;
  error?: string;
  retryCount: number;
  failedReason?: string;
  events: AgentLoopEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  message: string;
  threadId?: string;
  idempotencyKey?: string;
}

export interface TaskStore {
  create(input: CreateTaskInput): Task;
  get(id: string): Task | undefined;
  getOrThrow(id: string): Task;
  update(id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>): Task;
  setStatus(id: string, status: TaskStatus): Task;
  appendEvent(id: string, event: AgentLoopEvent): Task;
  listByThread(threadId: string): Task[];
  listByStatus(statuses: TaskStatus[]): Task[];
  list(): Task[];
}

export interface TaskEvent {
  taskId: string;
  type: 'task' | 'agent';
  data: TaskUpdate | AgentLoopEvent;
}

export interface TaskUpdate {
  status: TaskStatus;
  reply?: string;
  error?: string;
}
