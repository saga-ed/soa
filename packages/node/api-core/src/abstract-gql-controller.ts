import { injectable, inject } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';

// Resolver map type for SDL-first GraphQL
export interface ResolverMap {
    Query?: Record<string, (...args: any[]) => any>;
    Mutation?: Record<string, (...args: any[]) => any>;
    [key: string]: Record<string, (...args: any[]) => any> | undefined;
}

/**
 * Abstract base class for SDL-first GraphQL controllers
 *
 * Unlike AbstractTGQLController which uses TypeGraphQL decorators (code-first),
 * this class is for schema-first approach where .gql files define the schema
 * and resolvers are plain objects.
 */
@injectable()
export abstract class AbstractGQLController {
    static readonly controllerType = 'GQL';
    protected logger: ILogger;
    abstract readonly sectorName: string;

    constructor(@inject('ILogger') logger: ILogger) {
        this.logger = logger;
    }

    /**
     * Return resolver object for this controller
     *
     * Example:
     * ```typescript
     * getResolvers(): ResolverMap {
     *   return {
     *     Query: {
     *       users: () => this.getAllUsers(),
     *       user: (_, { id }) => this.getUserById(id),
     *     },
     *     Mutation: {
     *       createUser: (_, { name, email }) => this.createUser(name, email),
     *     },
     *   };
     * }
     * ```
     */
    abstract getResolvers(): ResolverMap;

    /**
     * Optional initialization hook called after DI container instantiation
     */
    async init(): Promise<void> {
        // Default implementation - override if needed
    }
}
