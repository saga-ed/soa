import type {
  CreateProjectZ as CreateProject,
  UpdateProjectZ as UpdateProject,
  GetProjectZ as GetProject,
  CreateRunZ as CreateRun,
  UpdateRunZ as UpdateRun,
  GetRunZ as GetRun,
  GetRunsByProjectZ as GetRunsByProject
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
  CreateProject,
  UpdateProject,
  GetProject,
  CreateRun,
  UpdateRun,
  GetRun,
  GetRunsByProject
}; 