import { injectable, inject, Container } from 'inversify';
import type { GQLServerConfig } from './gql-server-schema.js';
import type { ILogger } from '@hipponot/logger';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { buildSchema } from 'type-graphql';
import { printSchema } from 'graphql';
import type { Application } from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AbstractGQLController } from './abstract-gql-controller.js';

@injectable()
export class GQLServer {
  private apolloServer?: ApolloServer;

  constructor(
    @inject('GQLServerConfig') private config: GQLServerConfig,
    @inject('ILogger') private logger: ILogger
  ) {}

  public async init(
    container: Container,
    resolvers: Array<new (...args: any[]) => any>
  ): Promise<void> {
    // Ensure we have at least one resolver
    if (resolvers.length === 0) {
      throw new Error('At least one resolver is required');
    }

    // Bind all resolvers to the container
    for (const ResolverClass of resolvers) {
      container.bind(ResolverClass).toSelf().inSingletonScope();
    }

    // Instantiate and initialize all resolvers
    const resolverInstances: AbstractGQLController[] = [];
    for (const ResolverClass of resolvers) {
      const resolverInstance = await container.getAsync<AbstractGQLController>(ResolverClass);
      resolverInstances.push(resolverInstance);
      if ('init' in resolverInstance && typeof resolverInstance.init === 'function') {
        await resolverInstance.init();
      }
    }

    // Build TypeGraphQL schema with dynamically loaded resolvers
    const schema = await buildSchema({
      resolvers: resolvers as unknown as [Function, ...Function[]],
    });

    // Set up ApolloServer v4+ with playground configuration
    this.apolloServer = new ApolloServer({
      schema,
      introspection: this.config.enablePlayground,
      // Disable landing page if playground is disabled
      plugins: this.config.enablePlayground
        ? []
        : [
            {
              async serverWillStart() {
                return {
                  async drainServer() {
                    // Disable landing page
                  },
                };
              },
            },
          ],
    });
    await this.apolloServer.start();

    // Emit schemas if enabled
    if (this.config.emitSchema !== false) {
      // default to true
      const schemaDir = this.config.schemaDir || 'dist/schema';
      await this.emitSchemas(resolverInstances, schemaDir);
    }
  }

  /**
   * Emit SDL files for all sectors (grouped by sector name)
   */
  private async emitSchemas(
    resolverInstances: AbstractGQLController[],
    schemaDir: string
  ): Promise<void> {
    try {
      this.logger.info(`🔍 Emitting sector schemas to ${schemaDir}...`);

      // Ensure output directory exists
      await mkdir(schemaDir, { recursive: true });

      // Group resolvers by sector name
      const sectorGroups = new Map<string, AbstractGQLController[]>();

      for (const resolver of resolverInstances) {
        const sectorName = resolver.sectorName;
        if (!sectorGroups.has(sectorName)) {
          sectorGroups.set(sectorName, []);
        }
        sectorGroups.get(sectorName)!.push(resolver);
      }

      // Emit SDL for each sector
      for (const [sectorName, resolvers] of sectorGroups) {
        const fileName = `${sectorName}.graphql`;
        const outputPath = path.join(schemaDir, fileName);

        await this.emitSectorSDL(sectorName, resolvers, outputPath);
      }

      this.logger.info(
        `✅ Successfully emitted ${sectorGroups.size} sector schema file(s) to ${schemaDir}`
      );
    } catch (error) {
      this.logger.error('❌ Failed to emit schemas:', error as Error);
      throw error;
    }
  }

  /**
   * Emit SDL for a specific sector containing multiple resolvers
   */
  private async emitSectorSDL(
    sectorName: string,
    resolvers: AbstractGQLController[],
    outputPath: string
  ): Promise<void> {
    try {
      this.logger.debug(
        `Emitting SDL for sector '${sectorName}' with ${resolvers.length} resolver(s) to ${outputPath}`
      );

      // Build schema with all resolvers in this sector
      const resolverClasses = resolvers.map(r => r.constructor);
      const schema = await buildSchema({
        resolvers: resolverClasses as unknown as [Function, ...Function[]],
        validate: false, // Skip validation for sector-level emission
      });

      // Convert to SDL
      const sdl = printSchema(schema);

      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      await mkdir(outputDir, { recursive: true });

      // Write SDL file
      await writeFile(outputPath, sdl, 'utf-8');

      this.logger.info(`✅ Emitted SDL for sector '${sectorName}' to ${outputPath}`);
      this.logger.debug(`📊 Schema size: ${sdl.length} characters`);
    } catch (error) {
      this.logger.error(`❌ Failed to emit SDL for sector '${sectorName}':`, error as Error);
      throw error;
    }
  }

  public mountToApp(app: Application, basePath?: string): void {
    if (!this.apolloServer) {
      throw new Error('GQLServer must be initialized before mounting to app');
    }

    // Calculate the full mount path by combining basePath and mountPoint
    const fullMountPath = basePath
      ? `${basePath}${this.config.mountPoint}`
      : this.config.mountPoint;

    // Mount Apollo middleware at the calculated mount point
    // @ts-expect-error Apollo Server v4+ middleware type mismatch with Express
    app.use(fullMountPath, expressMiddleware(this.apolloServer, { context: async () => ({}) }));

    this.logger.info(`GraphQL server '${this.config.name}' mounted at '${fullMountPath}'`);

    // Log playground status
    if (this.config.enablePlayground) {
      this.logger.info(`GraphQL playground enabled and accessible at '${fullMountPath}'`);
    } else {
      this.logger.info(`GraphQL playground disabled for '${this.config.name}'`);
    }
  }

  public async stop(): Promise<void> {
    if (this.apolloServer) {
      await this.apolloServer.stop();
      this.logger.info(`GraphQL server '${this.config.name}' stopped.`);
    }
  }

  public getApolloServer(): ApolloServer | undefined {
    return this.apolloServer;
  }
}
