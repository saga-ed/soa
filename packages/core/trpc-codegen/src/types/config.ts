export interface TRPCCodegenConfig {
  /** Source configuration */
  source: {
    /** Path to sectors directory relative to config file */
    sectorsDir: string;
    /** Glob pattern for router files within sectors */
    routerPattern: string;
    /** Glob pattern for schema files within sectors */
    schemaPattern: string;
  };
  
  /** Generation configuration */
  generation: {
    /** Output directory for generated files */
    outputDir: string;
    /** Package name for the generated types package */
    packageName: string;
    /** Name of the generated router type */
    routerName: string;
  };
  
  /** Parsing configuration */
  parsing: {
    /** Regex pattern for extracting endpoint definitions */
    endpointPattern: RegExp;
    /** Regex pattern for extracting router method content */
    routerMethodPattern: RegExp;
  };

  /** Zod2ts configuration */
  zod2ts: {
    /** Whether to generate TypeScript types from Zod schemas */
    enabled: boolean;
    /** Output directory for generated TypeScript types (relative to generation.outputDir) */
    outputDir: string;
  };
}