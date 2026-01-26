import { v4 as uuidv4 } from 'uuid';
import type { Run } from './run.js';
import type { CreateRunInput, UpdateRunInput } from './schema/run.schemas.js';

/**
 * RunHelper class encapsulates business logic for Run operations.
 * This class demonstrates the recommended pattern for organizing business logic
 * and can easily be replaced with a real service in production.
 */
export class RunHelper {
  // Mock data store - in production, this would be a database connection
  private runs: Run[] = [
    {
      id: '1',
      projectId: '1',
      name: 'Initial Build',
      description: 'First build of the Saga SOA Platform',
      status: 'completed',
      config: { environment: 'development', version: '1.0.0' },
      createdAt: new Date('2024-01-01T10:00:00Z'),
      updatedAt: new Date('2024-01-01T10:00:00Z'),
      startedAt: new Date('2024-01-01T10:00:00Z'),
      completedAt: new Date('2024-01-01T10:30:00Z'),
    },
    {
      id: '2',
      projectId: '1',
      name: 'Integration Tests',
      description: 'Running integration test suite',
      status: 'running',
      config: { testSuite: 'integration', timeout: 300 },
      createdAt: new Date('2024-01-02T09:00:00Z'),
      updatedAt: new Date('2024-01-02T09:00:00Z'),
      startedAt: new Date('2024-01-02T09:00:00Z'),
    },
    {
      id: '3',
      projectId: '2',
      name: 'API Gateway Deploy',
      description: 'Deploying API Gateway to production',
      status: 'pending',
      config: { environment: 'production', region: 'us-east-1' },
      createdAt: new Date('2024-01-03T08:00:00Z'),
      updatedAt: new Date('2024-01-03T08:00:00Z'),
    },
  ];

  /**
   * Get all runs
   */
  getAllRuns(): Run[] {
    return [...this.runs];
  }

  /**
   * Get run by ID
   */
  getRunById(id: string): Run | null {
    return this.runs.find(run => run.id === id) || null;
  }

  /**
   * Get runs by project ID
   */
  getRunsByProject(projectId: string): Run[] {
    return this.runs.filter(run => run.projectId === projectId);
  }

  /**
   * Create a new run
   */
  createRun(input: CreateRunInput): Run {
    const now = new Date();
    const run: Run = {
      id: uuidv4(),
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      status: input.status,
      config: input.config,
      createdAt: now,
      updatedAt: now,
    };

    this.runs.push(run);
    return run;
  }

  /**
   * Update an existing run
   */
  updateRun(input: UpdateRunInput): Run | null {
    const runIndex = this.runs.findIndex(run => run.id === input.id);
    if (runIndex === -1) {
      return null;
    }

    const run = this.runs[runIndex]!;
    const updatedRun: Run = {
      id: run.id,
      projectId: run.projectId,
      name: input.name ?? run.name,
      description: input.description ?? run.description,
      status: input.status ?? run.status,
      config: input.config ?? run.config,
      createdAt: run.createdAt,
      updatedAt: new Date(),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    };

    // Update timestamps based on status changes
    if (input.status === 'running' && run.status !== 'running') {
      updatedRun.startedAt = new Date();
    } else if (
      (input.status === 'completed' || input.status === 'failed') &&
      run.status !== 'completed' &&
      run.status !== 'failed'
    ) {
      updatedRun.completedAt = new Date();
    }

    this.runs[runIndex] = updatedRun;
    return updatedRun;
  }

  /**
   * Delete a run
   */
  deleteRun(id: string): boolean {
    const runIndex = this.runs.findIndex(run => run.id === id);
    if (runIndex === -1) {
      return false;
    }

    this.runs.splice(runIndex, 1);
    return true;
  }
}
