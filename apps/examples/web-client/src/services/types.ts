import type {
  CreateProjectInput,
  UpdateProjectInput,
  GetProjectInput,
  CreateRunInput,
  UpdateRunInput,
  GetRunInput,
  GetRunsByProjectInput
} from '@saga-ed/soa-trpc-types';

export type EndpointId = 
  | 'project.getAllProjects'
  | 'project.getProjectById'
  | 'project.createProject'
  | 'project.updateProject'
  | 'project.deleteProject'
  | 'run.getAllRuns'
  | 'run.getRunById'
  | 'run.createRun'
  | 'run.updateRun'
  | 'run.deleteRun'
  | 'pubsub.ping'
  | 'pubsub.getEventDefinitions'
  | 'pubsub.getChannelInfo';

export interface Endpoint {
  id: EndpointId;
  name: string;
  method: 'GET' | 'POST';
  description: string;
  inputType: string | null;
  sampleInput: unknown;
  url: string;
}

export interface ApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ServiceInterface {
  executeEndpoint(endpoint: Endpoint, input: string): Promise<ApiResponse>;
  generateCode(endpoint: Endpoint, input: string): string;
}

export type {
  CreateProjectInput,
  UpdateProjectInput,
  GetProjectInput,
  CreateRunInput,
  UpdateRunInput,
  GetRunInput,
  GetRunsByProjectInput
}; 