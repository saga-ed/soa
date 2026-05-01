import {
    PostgreSqlContainer,
    type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
    RabbitMQContainer,
    type StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import { Pool } from 'pg';

export interface InfraHandle {
    /** Postgres URL pointing at the default `test` admin database. */
    postgresAdminUrl: string;
    /** AMQP URL with credentials. */
    rabbitmqUrl: string;
    /**
     * Create a fresh database within the running Postgres container and
     * return a URL pointing at it. Idempotent — calling twice with the
     * same name throws on the second create unless `dropIfExists` is set.
     */
    createDatabase: (name: string, opts?: { dropIfExists?: boolean }) => Promise<string>;
    /**
     * Run an arbitrary SQL block against a database (e.g., apply migrations
     * extracted from @saga-ed/soa-event-outbox / @saga-ed/soa-event-consumer + the
     * service's own table SQL).
     */
    runSql: (databaseUrl: string, sql: string) => Promise<void>;
    /** Stop both containers. Test suites should call this in afterAll. */
    stop: () => Promise<void>;
}

class TestcontainersInfraHandle implements InfraHandle {
    constructor(
        private readonly postgres: StartedPostgreSqlContainer,
        private readonly rabbitmq: StartedRabbitMQContainer,
    ) {}

    get postgresAdminUrl(): string {
        return this.postgres.getConnectionUri();
    }

    get rabbitmqUrl(): string {
        return this.rabbitmq.getAmqpUrl();
    }

    async createDatabase(
        name: string,
        opts: { dropIfExists?: boolean } = {},
    ): Promise<string> {
        const adminPool = new Pool({ connectionString: this.postgresAdminUrl });
        try {
            if (opts.dropIfExists) {
                await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`);
            }
            await adminPool.query(`CREATE DATABASE "${name}"`);
        } finally {
            await adminPool.end();
        }
        const url = new URL(this.postgresAdminUrl);
        url.pathname = `/${name}`;
        return url.toString();
    }

    async runSql(databaseUrl: string, sql: string): Promise<void> {
        const pool = new Pool({ connectionString: databaseUrl });
        try {
            await pool.query(sql);
        } finally {
            await pool.end();
        }
    }

    async stop(): Promise<void> {
        await Promise.all([this.postgres.stop(), this.rabbitmq.stop()]);
    }
}

export interface StartInfraOpts {
    postgresImage?: string;
    rabbitmqImage?: string;
}

/**
 * Start a Postgres container + RabbitMQ container in parallel, return a
 * handle that exposes their URLs and helpers for creating per-test databases.
 *
 * Usage:
 *   const infra = await startInfra();
 *   const dbUrl = await infra.createDatabase('identity');
 *   await infra.runSql(dbUrl, '...migrations...');
 *   // ...run integration test...
 *   await infra.stop();
 */
export async function startInfra(opts: StartInfraOpts = {}): Promise<InfraHandle> {
    const [postgres, rabbitmq] = await Promise.all([
        new PostgreSqlContainer(opts.postgresImage ?? 'postgres:17-alpine').start(),
        new RabbitMQContainer(opts.rabbitmqImage ?? 'rabbitmq:3.13-management-alpine').start(),
    ]);
    return new TestcontainersInfraHandle(postgres, rabbitmq);
}
