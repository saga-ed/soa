// Run entity type
export interface Run {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  config?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}
