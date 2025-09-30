import fg from 'fast-glob';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@hipponot/soa-logger';

@injectable()
export class ControllerLoader {
  private readonly ERROR_MESSAGES = {
    NO_REST_CONTROLLERS: 'No REST controllers found. Ensure you have files matching the expected pattern.',
    NO_GRAPHQL_RESOLVERS: 'No GraphQL resolvers found. Ensure you have files matching the expected pattern.',
    NO_TRPC_CONTROLLERS: 'No tRPC controllers found. Ensure you have files matching the expected pattern.',
    INVALID_CONTROLLER: 'Invalid controller structure. Controller must extend the appropriate base class.',
    LOAD_ERROR: 'Failed to load controllers from file:',
  } as const;

  constructor(@inject('ILogger') private logger: ILogger) {}

  async loadControllers<TBase>(
    globPatterns: string | string[],
    baseClass: abstract new (...args: any[]) => TBase
  ): Promise<[new (...args: any[]) => TBase, ...Array<new (...args: any[]) => TBase>]> {
    // Support single string, array, or varargs
    const patterns = Array.isArray(globPatterns) ? globPatterns : [globPatterns];

    // Read controllerType from the base class's static property
    const controllerType = (baseClass as any).controllerType || 'CONTROLLER';
    const typeLabel = ` ${controllerType}`;

    try {
      const files = await fg(patterns, { absolute: true });

      this.logger.info(`Found ${files.length}${typeLabel} files matching patterns: ${patterns.join(', ')}`);

      const controllers: Array<new (...args: any[]) => TBase> = [];
      const loadErrors: string[] = [];

      for (const file of files) {
        try {
          const mod = await import(pathToFileURL(file).href);
          let controllerFound = false;

          // Check default export first
          const candidate = mod.default;
          if (typeof candidate === 'function' && candidate.prototype instanceof baseClass) {
            controllers.push(candidate);
            controllerFound = true;
            const controllerName = candidate.name || 'UnnamedController';
            this.logger.info(`  ✓ [${controllerType}] ${controllerName} (default export from ${path.basename(file)})`);
          } else {
            // Check all named exports
            for (const key of Object.keys(mod)) {
              const named = mod[key];
              if (typeof named === 'function' && named.prototype instanceof baseClass) {
                controllers.push(named);
                controllerFound = true;
                const controllerName = named.name || key;
                this.logger.info(`  ✓ [${controllerType}] ${controllerName} (named export '${key}' from ${path.basename(file)})`);
              }
            }
          }

          if (!controllerFound) {
            this.logger.warn(`No valid${typeLabel} controller found in file: ${path.basename(file)}`);
          }
        } catch (error) {
          const errorMsg = `Failed to load file: ${path.basename(file)} - ${error instanceof Error ? error.message : String(error)}`;
          loadErrors.push(errorMsg);
          this.logger.error(errorMsg);
        }
      }

      // Log summary
      this.logger.info(`Successfully loaded ${controllers.length}${typeLabel} controllers from ${files.length} files`);
      if (loadErrors.length > 0) {
        this.logger.warn(`Failed to load ${loadErrors.length} files`);
      }

      if (controllers.length === 0) {
        const errorMsg = `No valid${typeLabel} controllers found for patterns: ${patterns.join(', ')}. Ensure you have files matching the expected pattern.`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      return controllers as [new (...args: any[]) => TBase, ...Array<new (...args: any[]) => TBase>];
    } catch (error) {
      const errorMsg = `Failed to load${typeLabel} controllers: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }
}
