import { injectable, inject, Container } from 'inversify';
import type { GQLServerConfig } from './gql-server-schema.js';
import type { ILogger } from '@saga-ed/soa-logger';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { printSchema } from 'graphql';
import type { Application } from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AbstractGQLController, ResolverMap } from './abstract-gql-controller.js';
import { loadAndMergeSchemas } from './utils/schema-loader.js';

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

        // Load and merge SDL schemas from .gql files
        const typeDefs = await loadAndMergeSchemas(this.config.schemaPatterns);
        this.logger.debug(`Loaded GraphQL schema (${typeDefs.length} chars)`);

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

        // Merge all resolver objects from controllers
        const mergedResolvers = this.mergeResolvers(resolverInstances);

        // Create executable schema from SDL and resolvers
        const schema = makeExecutableSchema({
            typeDefs,
            resolvers: mergedResolvers as any,
        });

        // Set up ApolloServer v4+ with playground configuration
        this.apolloServer = new ApolloServer({
            schema,
            introspection: this.config.enablePlayground,
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
            const schemaDir = this.config.schemaDir || 'dist/schema';
            await this.emitSchemas(resolverInstances, schema, schemaDir);
        }
    }

    /**
     * Merge resolver objects from multiple controllers
     */
    private mergeResolvers(resolverInstances: AbstractGQLController[]): ResolverMap {
        const merged: ResolverMap = {
            Query: {},
            Mutation: {},
        };

        for (const instance of resolverInstances) {
            const resolvers = instance.getResolvers();

            // Merge Query resolvers
            if (resolvers.Query) {
                if (!merged.Query) merged.Query = {};
                Object.assign(merged.Query, resolvers.Query);
            }

            // Merge Mutation resolvers
            if (resolvers.Mutation) {
                if (!merged.Mutation) merged.Mutation = {};
                Object.assign(merged.Mutation, resolvers.Mutation);
            }

            // Merge any custom type resolvers
            for (const [typeName, typeResolvers] of Object.entries(resolvers)) {
                if (typeName !== 'Query' && typeName !== 'Mutation') {
                    if (!merged[typeName]) {
                        merged[typeName] = {};
                    }
                    Object.assign(merged[typeName], typeResolvers);
                }
            }
        }

        return merged;
    }

    /**
     * Emit SDL files for all sectors (grouped by sector name)
     */
    private async emitSchemas(
        resolverInstances: AbstractGQLController[],
        schema: any,
        schemaDir: string
    ): Promise<void> {
        try {
            this.logger.info(`🔍 Emitting GraphQL schema to ${schemaDir}...`);

            // Ensure output directory exists
            await mkdir(schemaDir, { recursive: true });

            // Emit the full combined schema
            const sdl = printSchema(schema);
            const fullSchemaPath = path.join(schemaDir, 'schema.graphql');
            await writeFile(fullSchemaPath, sdl, 'utf-8');

            this.logger.info(`✅ Emitted full GraphQL schema to ${fullSchemaPath}`);
            this.logger.debug(`📊 Schema size: ${sdl.length} characters`);
        } catch (error) {
            this.logger.error('❌ Failed to emit schemas:', error as Error);
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

        this.logger.info(`GraphQL SDL server '${this.config.name}' mounted at '${fullMountPath}'`);

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
            this.logger.info(`GraphQL SDL server '${this.config.name}' stopped.`);
        }
    }

    public getApolloServer(): ApolloServer | undefined {
        return this.apolloServer;
    }
}
