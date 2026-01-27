export interface EndpointInfo {
  name: string;
  type: 'query' | 'mutation';
  inputSchema?: string;
}

export interface SectorInfo {
  name: string;
  endpoints: EndpointInfo[];
}

export interface GenerationResult {
  sectors: SectorInfo[];
  generatedFiles: string[];
  errors: string[];
}