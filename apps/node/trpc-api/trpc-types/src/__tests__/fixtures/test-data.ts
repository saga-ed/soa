import type { Project, Run } from '../../schemas/index.js';

// Test data for projects
export const mockProjects: Project[] = [
  {
    id: '1',
    name: 'Test Project 1',
    description: 'A test project',
    status: 'active',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  },
  {
    id: '2',
    name: 'Test Project 2',
    description: 'Another test project',
    status: 'inactive',
    createdAt: new Date('2024-01-02'),
    updatedAt: new Date('2024-01-02'),
  },
];

export const mockProject: Project = mockProjects[0]!;

// Test data for runs
export const mockRuns: Run[] = [
  {
    id: '1',
    projectId: '1',
    name: 'Test Run 1',
    description: 'A test run',
    status: 'completed',
    startedAt: new Date('2024-01-01T10:00:00Z'),
    completedAt: new Date('2024-01-01T11:00:00Z'),
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  },
  {
    id: '2',
    projectId: '1',
    name: 'Test Run 2',
    description: 'Another test run',
    status: 'running',
    startedAt: new Date('2024-01-02T10:00:00Z'),
    completedAt: undefined,
    createdAt: new Date('2024-01-02'),
    updatedAt: new Date('2024-01-02'),
  },
];

export const mockRun: Run = mockRuns[0]!;

// Valid test inputs
export const validCreateProjectInput = {
  name: 'New Project',
  description: 'A new project',
  status: 'active' as const,
};

export const validUpdateProjectInput = {
  id: '1',
  name: 'Updated Project',
  description: 'An updated project',
  status: 'active' as const,
};

export const validGetProjectInput = {
  id: '1',
};

export const validCreateRunInput = {
  projectId: '1',
  name: 'New Run',
  description: 'A new run',
  status: 'running' as const,
};

export const validUpdateRunInput = {
  id: '1',
  name: 'Updated Run',
  description: 'An updated run',
  status: 'completed' as const,
};

export const validGetRunInput = {
  id: '1',
};

// Invalid test inputs
export const invalidCreateProjectInput = {
  name: '', // Invalid: empty name
  status: 'invalid' as any, // Invalid: invalid status
};

export const invalidUpdateProjectInput = {
  id: '', // Invalid: empty id
  name: '', // Invalid: empty name
};

export const invalidGetProjectInput = {
  id: '', // Invalid: empty id
}; 