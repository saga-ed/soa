import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { Endpoint, ApiResponse, ServiceInterface } from './types';
import type { AppRouter } from '@saga-soa/trpc-types';

export class TrpcClientService implements ServiceInterface {
  private client: ReturnType<typeof createTRPCClient<AppRouter>>;

  constructor() {
    // Now with aligned TypeScript versions, we can use the proper AppRouter type
    this.client = createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: 'http://localhost:5000/saga-soa/v1/trpc',
        }),
      ],
    });
  }

  async executeEndpoint(endpoint: Endpoint, input: string): Promise<ApiResponse> {
    try {
      let result: any;

      switch (endpoint.id) {
        case 'project.getAllProjects':
          result = await this.client.project.getAllProjects.query();
          break;
        case 'project.getProjectById':
          result = await this.client.project.getProjectById.query(JSON.parse(input));
          break;
        case 'project.createProject':
          result = await this.client.project.createProject.mutate(JSON.parse(input));
          break;
        case 'project.updateProject':
          result = await this.client.project.updateProject.mutate(JSON.parse(input));
          break;
        case 'project.deleteProject':
          result = await this.client.project.deleteProject.mutate(JSON.parse(input));
          break;
        case 'run.getAllRuns':
          result = await this.client.run.getAllRuns.query();
          break;
        case 'run.getRunById':
          result = await this.client.run.getRunById.query(JSON.parse(input));
          break;
        case 'run.createRun':
          result = await this.client.run.createRun.mutate(JSON.parse(input));
          break;
        case 'run.updateRun':
          result = await this.client.run.updateRun.mutate(JSON.parse(input));
          break;
        case 'run.deleteRun':
          result = await this.client.run.deleteRun.mutate(JSON.parse(input));
          break;
        case 'pubsub.ping':
          result = await this.client.pubsub.ping.mutate(JSON.parse(input));
          break;
        case 'pubsub.getEventDefinitions':
          result = await this.client.pubsub.getEventDefinitions.query();
          break;
        case 'pubsub.getChannelInfo':
          result = await this.client.pubsub.getChannelInfo.query();
          break;
        default:
          throw new Error(`Unknown endpoint: ${endpoint.id}`);
      }

      return {
        success: true,
        data: result
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'An error occurred'
      };
    }
  }

  generateCode(endpoint: Endpoint, input: string): string {
    const inputObj = input.trim() ? JSON.parse(input) : null;
    const inputStr = inputObj ? JSON.stringify(inputObj, null, 2) : '';
    
    switch (endpoint.id) {
      case 'project.getAllProjects':
        return `const result = await trpc.project.getAllProjects.query();`;
      case 'project.getProjectById':
        return `const result = await trpc.project.getProjectById.query(${inputStr});`;
      case 'project.createProject':
        return `const result = await trpc.project.createProject.mutate(${inputStr});`;
      case 'project.updateProject':
        return `const result = await trpc.project.updateProject.mutate(${inputStr});`;
      case 'project.deleteProject':
        return `const result = await trpc.project.deleteProject.mutate(${inputStr});`;
      case 'run.getAllRuns':
        return `const result = await trpc.run.getAllRuns.query();`;
      case 'run.getRunById':
        return `const result = await trpc.run.getRunById.query(${inputStr});`;
      case 'run.createRun':
        return `const result = await trpc.run.createRun.mutate(${inputStr});`;
      case 'run.updateRun':
        return `const result = await trpc.run.updateRun.mutate(${inputStr});`;
      case 'run.deleteRun':
        return `const result = await trpc.run.deleteRun.mutate(${inputStr});`;
      case 'pubsub.ping':
        return `const result = await trpc.pubsub.ping.mutate(${inputStr});`;
      case 'pubsub.getEventDefinitions':
        return `const result = await trpc.pubsub.getEventDefinitions.query();`;
      case 'pubsub.getChannelInfo':
        return `const result = await trpc.pubsub.getChannelInfo.query();`;
      default:
        return `// Unknown endpoint: ${endpoint.id}`;
    }
  }

  // Return plain text for syntax highlighting to be handled by the UI
  syntaxHighlight(code: string): string {
    return code;
  }
}