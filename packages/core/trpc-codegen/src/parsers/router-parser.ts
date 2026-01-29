import type { EndpointInfo } from '../types/sector.js';
import type { TRPCCodegenConfig } from '../types/config.js';

export function parseRouterFile(
  routerContent: string, 
  parsingConfig: TRPCCodegenConfig['parsing']
): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  
  // Parse the router content to extract endpoints
  // Look for the pattern: return router({ ... }) inside createRouter()
  const createRouterMatch = routerContent.match(parsingConfig.routerMethodPattern);
  
  if (!createRouterMatch) {
    return endpoints;
  }
  
  const routerObjectContent = createRouterMatch[1];
  
  // Extract individual endpoint definitions
  // Reset regex lastIndex to avoid issues with global flag
  const endpointPattern = new RegExp(parsingConfig.endpointPattern.source, parsingConfig.endpointPattern.flags);
  
  let match;
  while ((match = endpointPattern.exec(routerObjectContent)) !== null) {
    const [, endpointName, inputSchema, methodType] = match;
    
    if (methodType === 'query' || methodType === 'mutation') {
      endpoints.push({
        name: endpointName,
        type: methodType,
        inputSchema: inputSchema || undefined
      });
    }
  }
  
  return endpoints;
}