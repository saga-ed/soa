export interface SectorInfo {
  name: string;
  resolvers: ResolverInfo[];
  types: TypeInfo[];
  inputs: InputInfo[];
}

export interface ResolverInfo {
  className: string;
  filePath: string;
  sectorName: string;
  queries: EndpointInfo[];
  mutations: EndpointInfo[];
  targetType: string;
}

export interface TypeInfo {
  className: string;
  filePath: string;
  sectorName: string;
  fields: FieldInfo[];
}

export interface InputInfo {
  className: string;
  filePath: string;
  sectorName: string;
  fields: FieldInfo[];
}

export interface EndpointInfo {
  name: string;
  returnType: string;
  isArray: boolean;
  args: ArgumentInfo[];
}

export interface FieldInfo {
  name: string;
  type: string;
  nullable?: boolean;
  isArray?: boolean;
}

export interface ArgumentInfo {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface GenerationResult {
  schemaFile: string;
  typeFiles: string[];
  sectorCount: number;
}

export interface ManifestEntry {
  name: string;
  resolvers: string[];
  types: string[];
  inputs: string[];
}

export interface OutputInfo {
  directory: string;
  files: string[];
}

export interface CodegenManifest {
  generatedAt: string;
  config: {
    source: {
      sectorsDir: string;
      resolverPattern: string;
      typePattern: string;
      inputPattern: string;
    };
    generation: {
      outputDir: string;
      packageName: string;
      schemaName?: string;
    };
    sdl: {
      enabled: boolean;
      outputDir: string;
      fileName?: string;
      emitBySector: boolean;
    };
    graphqlCodegen: {
      enabled: boolean;
      schemaPath: string;
      outputDir: string;
      plugins: string[];
    };
  };
  sources: {
    sectors: ManifestEntry[];
  };
  outputs: {
    schema: OutputInfo;
    types: OutputInfo;
  };
}