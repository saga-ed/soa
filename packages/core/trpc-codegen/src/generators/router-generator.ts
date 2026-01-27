import fs from 'fs/promises';
import path from 'path';
import type { SectorInfo, EndpointInfo } from '../types/sector.js';
import type { TRPCCodegenConfig } from '../types/config.js';

export class RouterGenerator {
  constructor(private config: TRPCCodegenConfig, private basePath: string) {}

  async generateRouter(sectorInfos: SectorInfo[]): Promise<string> {
    const outputPath = path.resolve(this.basePath, this.config.generation.outputDir, 'router.ts');
    
    // Ensure output directory exists
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    
    // Generate dynamic imports
    const imports = sectorInfos.map(sector => 
      `import * as ${sector.name}Schemas from './schemas/${sector.name}-schemas.js';`
    ).join('\n');
    
    // Generate dynamic router structure
    const routerSections = sectorInfos.map(sector => {
      const endpointDefinitions = sector.endpoints.map(endpoint =>
        `    ${this.generateEndpointDefinition(endpoint, sector.name)},`
      ).join('\n');
      
      return `  ${sector.name}: t.router({\n${endpointDefinitions}\n  })`;
    }).join(',\n');
    
    // Generate the complete router content
    const routerContent = `// Auto-generated - do not edit
// This file is dynamically generated based on sectors in src/sectors/*/trpc/
import { initTRPC } from '@trpc/server';
${imports}

const t = initTRPC.create();

export const static${this.config.generation.routerName} = t.router({
${routerSections},
});

export type ${this.config.generation.routerName} = typeof static${this.config.generation.routerName};
`;
    
    await fs.writeFile(outputPath, routerContent);
    
    
    return outputPath;
  }

  private generateEndpointDefinition(endpoint: EndpointInfo, sectorName: string): string {
    const schemaRef = endpoint.inputSchema 
      ? `${sectorName}Schemas.${endpoint.inputSchema}` 
      : undefined;
    
    if (endpoint.inputSchema) {
      return `${endpoint.name}: t.procedure.input(${schemaRef}).${endpoint.type}(() => ({}))`;
    } else {
      return `${endpoint.name}: t.procedure.${endpoint.type}(() => ${endpoint.type === 'query' ? '[]' : '{}'})`;
    }
  }
}