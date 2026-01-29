import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ResolverInfo, EndpointInfo, ArgumentInfo } from '../types/sector.js';
import type { TGQLCodegenConfig } from '../types/config.js';

export class ResolverParser {
  constructor(private config: TGQLCodegenConfig) {}

  async parseResolver(filePath: string, sectorName: string): Promise<ResolverInfo | null> {
    try {
      const content = readFileSync(filePath, 'utf-8');
      
      // Extract resolver class name
      const resolverMatch = content.match(/@Resolver\s*\(\s*\(\)\s*=>\s*(\w+)\s*\)\s*export\s+class\s+(\w+)/);
      if (!resolverMatch || !resolverMatch[1] || !resolverMatch[2]) {
        console.warn(`No resolver found in ${filePath}`);
        return null;
      }

      const targetType = resolverMatch[1];
      const className = resolverMatch[2];

      console.log(`  🔧 Found resolver: ${className} for ${targetType}`);

      // Parse queries
      const queries = this.parseEndpoints(content, 'Query');
      
      // Parse mutations
      const mutations = this.parseEndpoints(content, 'Mutation');

      return {
        className,
        filePath,
        sectorName,
        queries,
        mutations,
        targetType
      };
    } catch (error) {
      console.error(`Error parsing resolver ${filePath}:`, error);
      return null;
    }
  }

  private parseEndpoints(content: string, type: 'Query' | 'Mutation'): EndpointInfo[] {
    const endpoints: EndpointInfo[] = [];
    
    // Match @Query or @Mutation decorators with their methods
    const pattern = new RegExp(
      `@${type}\\s*\\(\\s*\\(\\)\\s*=>\\s*(\\[?)([\\w\\[\\]]+)(\\]?)(?:\\s*,\\s*\\{[^}]*\\})?\\s*\\)\\s*([\\w\\s]*?)\\s*(\\w+)\\s*\\(([^)]*)\\)`,
      'g'
    );

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const [, arrayStart, returnType, arrayEnd, , methodName, argsString] = match;
      
      // Skip if required parts are missing
      if (!returnType || !methodName) {
        continue;
      }
      
      const isArray = !!(arrayStart || arrayEnd);
      const cleanReturnType = returnType.replace(/[\[\]]/g, '');
      
      // Parse arguments
      const args = this.parseArguments(argsString || '');
      
      endpoints.push({
        name: methodName,
        returnType: cleanReturnType,
        isArray,
        args
      });

      console.log(`    📍 ${type}: ${methodName} -> ${isArray ? '[' : ''}${cleanReturnType}${isArray ? ']' : ''}`);
    }

    return endpoints;
  }

  private parseArguments(argsString: string): ArgumentInfo[] {
    const args: ArgumentInfo[] = [];
    
    if (!argsString.trim()) {
      return args;
    }

    // Match @Arg decorators
    const argPattern = /@Arg\s*\(\s*['"](\w+)['"](?:\s*,\s*\{[^}]*\})?\s*\)\s*(\w+)(?:\s*:\s*(\w+))?/g;
    
    let match;
    while ((match = argPattern.exec(argsString)) !== null) {
      const [, argName, paramName, paramType] = match;
      
      // Skip if required parts are missing
      if (!argName || !paramName) {
        continue;
      }
      
      args.push({
        name: argName,
        type: paramType || 'any',
        nullable: argsString.includes(`${paramName}?`)
      });
    }

    return args;
  }
}