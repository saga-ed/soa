import { injectable, inject } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import { buildSchema } from 'type-graphql';
import { printSchema } from 'graphql';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

@injectable()
export abstract class AbstractTGQLController {
    static readonly controllerType = 'TGQL';
    protected logger: ILogger;
    abstract readonly sectorName: string;

    constructor(@inject('ILogger') logger: ILogger) {
        this.logger = logger;
    }

    /**
     * Emit SDL for this resolver to the specified output path
     */
    async emitSDL(outputPath: string): Promise<void> {
        try {
            this.logger.debug(`Emitting SDL for ${this.constructor.name} to ${outputPath}`);

            // Build schema with just this resolver
            const schema = await buildSchema({
                resolvers: [this.constructor as new (...args: unknown[]) => unknown],
                validate: false, // Skip validation for individual resolvers
            });

            // Convert to SDL
            const sdl = printSchema(schema);

            // Ensure output directory exists
            const outputDir = path.dirname(outputPath);
            await mkdir(outputDir, { recursive: true });

            // Write SDL file
            await writeFile(outputPath, sdl, 'utf-8');

            this.logger.info(`✅ Emitted SDL for ${this.constructor.name} to ${outputPath}`);
            this.logger.debug(`📊 Schema size: ${sdl.length} characters`);

        } catch (error) {
            this.logger.error(`❌ Failed to emit SDL for ${this.constructor.name}:`, error as Error);
            throw error;
        }
    }
}
