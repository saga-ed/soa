import type { Endpoint } from './types';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  GetProjectInput,
  CreateRunInput,
  UpdateRunInput,
  GetRunInput
} from '@saga-soa/trpc-types';

export const ENDPOINTS: Endpoint[] = [
  // Project endpoints
  {
    id: 'project.getAllProjects',
    name: 'Get All Projects',
    method: 'GET',
    description: 'Retrieve all projects',
    inputType: null,
    sampleInput: null,
    url: '/saga-soa/v1/trpc/project.getAllProjects'
  },
  {
    id: 'project.getProjectById',
    name: 'Get Project by ID',
    method: 'GET',
    description: 'Retrieve a specific project by ID',
    inputType: 'GetProjectInput',
    sampleInput: { id: '1' } as GetProjectInput,
    url: '/saga-soa/v1/trpc/project.getProjectById'
  },
  {
    id: 'project.createProject',
    name: 'Create Project',
    method: 'POST',
    description: 'Create a new project',
    inputType: 'CreateProjectInput',
    sampleInput: {
      name: 'New Project',
      description: 'A new project description',
      status: 'active' as const
    } as CreateProjectInput,
    url: '/saga-soa/v1/trpc/project.createProject'
  },
  {
    id: 'project.updateProject',
    name: 'Update Project',
    method: 'POST',
    description: 'Update an existing project',
    inputType: 'UpdateProjectInput',
    sampleInput: {
      id: '1',
      name: 'Updated Project',
      description: 'Updated project description',
      status: 'active' as const
    } as UpdateProjectInput,
    url: '/saga-soa/v1/trpc/project.updateProject'
  },
  {
    id: 'project.deleteProject',
    name: 'Delete Project',
    method: 'POST',
    description: 'Delete a project',
    inputType: 'GetProjectInput',
    sampleInput: { id: '1' } as GetProjectInput,
    url: '/saga-soa/v1/trpc/project.deleteProject'
  },
  
  // Run endpoints
  {
    id: 'run.getAllRuns',
    name: 'Get All Runs',
    method: 'GET',
    description: 'Retrieve all runs',
    inputType: null,
    sampleInput: null,
    url: '/saga-soa/v1/trpc/run.getAllRuns'
  },
  {
    id: 'run.getRunById',
    name: 'Get Run by ID',
    method: 'GET',
    description: 'Retrieve a specific run by ID',
    inputType: 'GetRunInput',
    sampleInput: { id: '1' } as GetRunInput,
    url: '/saga-soa/v1/trpc/run.getRunById'
  },
  {
    id: 'run.createRun',
    name: 'Create Run',
    method: 'POST',
    description: 'Create a new run',
    inputType: 'CreateRunInput',
    sampleInput: {
      projectId: '1',
      name: 'New Run',
      description: 'A new run description',
      status: 'pending' as const,
      config: { timeout: 30000 }
    } as CreateRunInput,
    url: '/saga-soa/v1/trpc/run.createRun'
  },
  {
    id: 'run.updateRun',
    name: 'Update Run',
    method: 'POST',
    description: 'Update an existing run',
    inputType: 'UpdateRunInput',
    sampleInput: {
      id: '1',
      name: 'Updated Run',
      description: 'Updated run description',
      status: 'completed' as const,
      config: { timeout: 30000 }
    } as UpdateRunInput,
    url: '/saga-soa/v1/trpc/run.updateRun'
  },
  {
    id: 'run.deleteRun',
    name: 'Delete Run',
    method: 'POST',
    description: 'Delete a run',
    inputType: 'GetRunInput',
    sampleInput: { id: '1' } as GetRunInput,
    url: '/saga-soa/v1/trpc/run.deleteRun'
  },

  // PubSub endpoints
  {
    id: 'pubsub.ping',
    name: 'Send Ping Message',
    method: 'POST',
    description: 'Send a ping message and receive automatic pong response',
    inputType: 'PingMessageInput',
    sampleInput: { message: 'Hello from web client!' },
    url: '/saga-soa/v1/trpc/pubsub.ping'
  },
  {
    id: 'pubsub.getEventDefinitions',
    name: 'Get Event Definitions',
    method: 'GET',
    description: 'Get available pubsub event definitions and schemas',
    inputType: null,
    sampleInput: null,
    url: '/saga-soa/v1/trpc/pubsub.getEventDefinitions'
  },
  {
    id: 'pubsub.getChannelInfo',
    name: 'Get Channel Information',
    method: 'GET',
    description: 'Get information about the pingpong channel',
    inputType: null,
    sampleInput: null,
    url: '/saga-soa/v1/trpc/pubsub.getChannelInfo'
  }
]; 