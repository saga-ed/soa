/**
 * Abstract base controller for fixture management endpoints.
 *
 * Provides standard HTTP endpoints for fixture lifecycle operations:
 * store, restore, async creation, provision, and credential export.
 *
 * Subclasses must provide:
 * - `fixture_types` — map of supported fixture type definitions
 * - `fixtures_dir` — path to directory containing bash create scripts
 *
 * Subclasses may override:
 * - `role_mappings` — domain role → test framework role mapping
 * - `suite_roles` — test suite → required roles
 * - `fixture_capabilities` — fixture type → capability strings
 * - `default_password` — password for credential export
 * - `ssm_prefix` — SSM parameter path prefix
 * - `services_to_snapshot` — infra-compose service names to snapshot
 */

import 'reflect-metadata';
import { spawn as child_spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { resolve as path_resolve } from 'path';
import { hostname } from 'os';
import { Post, Get, Body, QueryParam, Param } from 'routing-controllers';
import { injectable, inject } from 'inversify';
import type { MongoClient } from 'mongodb';
import { MONGO_CLIENT } from '@saga-ed/soa-db';
import type { IMongoConnMgr } from '@saga-ed/soa-db';
// SSMClient is dynamically imported at runtime to avoid large SDK dependency at startup.
type SSMClient = any;
import { snapshot, switch_profile, reset, get_active_profile } from '@saga-ed/infra-compose';
import type { ILogger } from '@saga-ed/soa-logger';
import { AbstractRestController } from '@saga-ed/soa-api-core';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core';
import type { FixtureTypeDefinition, RoleMapping, SuiteRoles, ProvisionState, ProvisionStatus } from './types.js';

/** Config injected into the controller via DI. */
export interface FixtureControllerConfig {
    mongo_uri: string;
    db_name: string;
    sql_host?: string;
    site_url?: string;
    default_profile?: string;
    metadata_collection?: string;
    jobs_collection?: string;
    service_name?: string;
    health_url?: string;
}

@injectable()
export abstract class AbstractFixtureController extends AbstractRestController {
    readonly sectorName = 'fixture';
    private mongo_client!: MongoClient;
    private mongo_mgr!: IMongoConnMgr;
    private _ssm: SSMClient | null = null;
    protected vm_name = hostname().split('.')[0];

    // ── Abstract: subclasses must implement ──

    /** Map of fixture type ID → definition. */
    abstract get fixture_types(): Record<string, FixtureTypeDefinition>;

    /** Absolute path to directory containing `create-fixture-{type}.sh` scripts. */
    abstract get fixtures_dir(): string;

    // ── Optional overrides ──

    /** Domain role → test framework roles. Override to enable credential export. */
    get role_mappings(): RoleMapping { return {}; }

    /** Test suite → required roles. Override to enable suite-grouped exports. */
    get suite_roles(): SuiteRoles { return {}; }

    /** Fixture type → capability strings. Override for capability publishing. */
    get fixture_capabilities(): Record<string, string[]> { return {}; }

    /** Default password for credential export. */
    get default_password(): string { return 'saga'; }

    /** SSM parameter prefix. */
    get ssm_prefix(): string { return `/dev/fixture/${this.vm_name}`; }

    /** infra-compose service names to include in snapshots. */
    get services_to_snapshot(): string[] { return ['mongo', 'mysql']; }

    constructor(
        @inject('ILogger') logger: ILogger,
        @inject('FixtureControllerConfig') protected ctrl_config: FixtureControllerConfig,
        @inject(MONGO_CLIENT) mongo_client: MongoClient,
        @inject('IMongoConnMgr') mongo_mgr: IMongoConnMgr,
        @inject('ExpressServerConfig') serverConfig?: ExpressServerConfig,
    ) {
        super(logger, 'fixture', serverConfig);
        this.mongo_client = mongo_client;
        this.mongo_mgr = mongo_mgr;
    }

    // ── Lifecycle ──

    /** Override in subclass for additional init. MongoDB is connected via DI. */
    async init() {
        this.logger.info(`FixtureController: connected to MongoDB at ${this.ctrl_config.mongo_uri}`);
    }

    protected async reconnect_mongo() {
        await this.mongo_mgr.disconnect();
        await this.mongo_mgr.connect();
        this.mongo_client = this.mongo_mgr.getClient();
        this.logger.info('FixtureController: reconnected to MongoDB');
    }

    // ── Helpers ──

    protected get metadata_collection_name() {
        return this.ctrl_config.metadata_collection || 'fixture_metadata';
    }

    protected get jobs_collection_name() {
        return this.ctrl_config.jobs_collection || 'fixture_jobs';
    }

    protected get metadata_collection() {
        return this.mongo_client.db(this.ctrl_config.db_name).collection(this.metadata_collection_name);
    }

    protected get jobs_collection() {
        return this.mongo_client.db(this.ctrl_config.db_name).collection(this.jobs_collection_name);
    }

    protected get default_profile() {
        return this.ctrl_config.default_profile || 'default';
    }

    private async get_ssm(): Promise<any> {
        if (!this._ssm) {
            // Dynamic import avoids bundling the large AWS SDK at build time.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mod = await import('@aws-sdk/client-ssm' as string);
            this._ssm = new mod.SSMClient({ region: 'us-west-2' });
        }
        return this._ssm;
    }

    // ── Snapshot / Restore ──

    /** Backward-compat alias — fixture-admin Lambda proxies to /snapshot. */
    @Post('/snapshot')
    async snapshot_fixture(@Body() body: { fixture_id: string; force?: boolean }) {
        return this.store(body);
    }

    @Post('/store')
    async store(@Body() body: { fixture_id: string; force?: boolean }) {
        const { fixture_id, force = true } = body;

        const doc = await this.metadata_collection.findOne({ fixture_id });
        if (!doc) {
            return { ok: false, error: `Fixture '${fixture_id}' not found in ${this.metadata_collection_name}` };
        }

        const result = await snapshot({ profile: fixture_id, services: this.services_to_snapshot, force });
        if (result.status !== 0) {
            return { ok: false, error: `snapshot failed (exit ${result.status})` };
        }

        const snapshot_at = new Date();
        await this.metadata_collection.updateOne(
            { fixture_id },
            { $set: { snapshot_profile: fixture_id, snapshot_at } },
        );

        return { ok: true, snapshot_profile: fixture_id, snapshot_at };
    }

    @Post('/restore')
    async restore(@Body() body: { fixture_id: string }) {
        const { fixture_id } = body;

        const doc = await this.metadata_collection.findOne({ fixture_id });
        if (!doc) {
            return { ok: false, error: `Fixture '${fixture_id}' not found in ${this.metadata_collection_name}` };
        }

        const snapshot_profile: string | undefined = (doc as any).snapshot_profile;
        if (!snapshot_profile) {
            return { ok: false, error: `Fixture '${fixture_id}' has no snapshot. Create one first.` };
        }

        const result = await switch_profile({ profile: snapshot_profile });
        if (result.status !== 0) {
            return { ok: false, error: `infra-compose switch failed (exit ${result.status})` };
        }

        return { ok: true, snapshot_profile };
    }

    // ── Async fixture creation ──

    @Get('/create-types')
    async list_create_types() {
        const dir = this.fixtures_dir;
        const types: { id: string; name: string; has_ts_creator: boolean; est_seconds: number }[] = [];

        // Discover from bash scripts
        if (existsSync(dir)) {
            for (const file of readdirSync(dir)) {
                const match = file.match(/^create-fixture-(.+)\.sh$/);
                if (!match || !match[1]) continue;
                const id: string = match[1];
                const def = this.fixture_types[id];
                types.push({
                    id,
                    name: def?.name || id,
                    has_ts_creator: !!def?.creator,
                    est_seconds: def?.est_seconds || 60,
                });
            }
        }

        // Include TS-only creators not backed by bash scripts
        for (const [id, def] of Object.entries(this.fixture_types)) {
            if (def.creator && !types.some(t => t.id === id)) {
                types.push({
                    id,
                    name: def.name,
                    has_ts_creator: true,
                    est_seconds: def.est_seconds,
                });
            }
        }

        return { ok: true, types };
    }

    /** Resolve and validate a fixture type from request body. */
    private resolve_fixture_type(body: { fixture_type?: string; fixture_id?: string; force_adhoc?: boolean }) {
        const fixture_type = body.fixture_type || Object.keys(this.fixture_types)[0] || 'default';
        const fixture_id = body.fixture_id || fixture_type;
        const force_adhoc = body.force_adhoc ?? false;
        const script = path_resolve(this.fixtures_dir, `create-fixture-${fixture_type}.sh`);
        const has_ts = !!this.fixture_types[fixture_type]?.creator;
        const valid = existsSync(script) || has_ts;
        return { fixture_type, fixture_id, force_adhoc, valid };
    }

    @Post('/create-async')
    async create_async(@Body() body: { fixture_type?: string; fixture_id?: string; force_adhoc?: boolean }) {
        const { fixture_type, fixture_id, force_adhoc, valid } = this.resolve_fixture_type(body);
        if (!valid) {
            return { ok: false, error: `Unknown fixture type: ${fixture_type}` };
        }

        const resolved_fixture_id = fixture_id;
        const job_id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        await this.jobs_collection.insertOne({
            _id: job_id as any,
            status: 'running',
            fixture_type,
            fixture_id: resolved_fixture_id,
            started_at: new Date(),
            output: [] as string[],
        });

        this.run_create_job(job_id, fixture_type, resolved_fixture_id, force_adhoc).catch(() => {});

        return { ok: true, job_id };
    }

    @Get('/create-status/:job_id')
    async create_status(@Param('job_id') job_id: string) {
        const job = await this.jobs_collection.findOne({ _id: job_id } as any);
        if (!job) {
            return { ok: false, error: `Job ${job_id} not found` };
        }
        return {
            ok: true,
            status: job.status,
            fixture_type: job.fixture_type,
            fixture_id: job.fixture_id,
            started_at: job.started_at,
            completed_at: job.completed_at || null,
            result: job.result || null,
            error: job.error_message || null,
            output: job.output || [],
        };
    }

    // ── Provision lifecycle ──

    private provision_state: ProvisionState | null = null;

    @Post('/provision')
    async provision(@Body() body: { fixture_type?: string; fixture_id?: string; force_adhoc?: boolean }) {
        const { fixture_type, fixture_id: resolved_id, force_adhoc, valid } = this.resolve_fixture_type(body);
        if (!valid) {
            return { ok: false, error: `Unknown fixture type: ${fixture_type}` };
        }

        if (this.provision_state && !['ready', 'failed'].includes(this.provision_state.status)) {
            return { ok: false, error: `Provision already in progress (${this.provision_state.status})` };
        }

        this.provision_state = {
            status: 'resetting',
            fixture_type,
            fixture_id: resolved_id,
            started_at: new Date(),
            completed_at: null,
            error: null,
            user_count: null,
        };

        this.run_provision_job(fixture_type, resolved_id, force_adhoc).catch(() => {});

        return { ok: true, job_id: `prov-${Date.now().toString(36)}` };
    }

    @Get('/provision-status')
    async provision_status() {
        if (!this.provision_state) {
            return { ok: true, status: 'idle' };
        }
        return {
            ok: true,
            status: this.provision_state.status,
            provision_status: this.provision_state.status,
            fixture_type: this.provision_state.fixture_type,
            fixture_id: this.provision_state.fixture_id,
            started_at: this.provision_state.started_at,
            completed_at: this.provision_state.completed_at,
            error: this.provision_state.error,
            ready: this.provision_state.status === 'ready',
            user_count: this.provision_state.user_count,
            active_profile: get_active_profile(),
        };
    }

    private async run_provision_job(fixture_type: string, fixture_id: string, force_adhoc: boolean) {
        const update = (status: ProvisionStatus) => {
            if (this.provision_state) {
                this.provision_state.status = status;
            }
            this.logger.info(`[provision] ${status}`);
        };

        try {
            // Step 1: Reset to seed profile
            this.logger.info(`Provision: resetting to ${this.default_profile} seed`);
            const reset_result = await reset({ profile: this.default_profile });
            if (reset_result.status !== 0) {
                throw new Error(`Reset to seed failed (exit ${reset_result.status})`);
            }

            await this.reconnect_mongo();
            await this.on_after_reset();

            const active_after_reset = get_active_profile();
            if (active_after_reset?.profile !== this.default_profile) {
                throw new Error(`Expected profile ${this.default_profile} after reset, got ${active_after_reset?.profile}`);
            }

            // Step 2: Create fixture
            update('creating');
            this.logger.info(`Provision: creating ${fixture_type} as ${fixture_id}`);

            const create_job_id = `create-${Date.now().toString(36)}`;
            await this.jobs_collection.insertOne({
                _id: create_job_id as any,
                status: 'running',
                fixture_type,
                fixture_id,
                started_at: new Date(),
                output: [] as string[],
            });
            await this.run_create_job(create_job_id, fixture_type, fixture_id, force_adhoc);

            const create_result = await this.jobs_collection.findOne({ _id: create_job_id } as any);
            if (create_result?.status !== 'completed') {
                throw new Error(`Fixture creation failed: ${create_result?.error_message || 'unknown'}`);
            }

            // Step 3: Switch to snapshot
            update('switching');
            this.logger.info(`Provision: switching to snapshot ${fixture_id}`);
            const switch_result = await switch_profile({ profile: fixture_id });
            if (switch_result.status !== 0) {
                throw new Error(`Switch to snapshot failed (exit ${switch_result.status})`);
            }
            await this.reconnect_mongo();
            await this.on_after_switch();

            // Step 4: Verify
            update('verifying');

            const active_after_switch = get_active_profile();
            if (active_after_switch?.profile !== fixture_id) {
                throw new Error(`Expected profile ${fixture_id} after switch, got ${active_after_switch?.profile}`);
            }

            const export_data = await this.build_playwright_export(
                'active',
                this.ctrl_config.site_url || `https://${this.vm_name}.wootmath.com`,
            );
            if (!export_data.ok || !export_data.user_logins || Object.keys(export_data.user_logins).length === 0) {
                throw new Error(`Credential verification failed: ${(export_data as any).error || 'no user_logins'}`);
            }

            const logins = export_data.user_logins as Record<string, Record<string, any[]>>;
            const user_count = Object.values(logins)
                .flatMap(suite => Object.values(suite))
                .reduce((sum: number, users: any[]) => sum + users.length, 0);

            if (this.provision_state) {
                this.provision_state.status = 'ready';
                this.provision_state.completed_at = new Date();
                this.provision_state.user_count = user_count;
            }
            this.logger.info(`Provision: ready — profile ${fixture_id}, ${user_count} credentials`);
        } catch (err: any) {
            if (this.provision_state) {
                this.provision_state.status = 'failed';
                this.provision_state.completed_at = new Date();
                this.provision_state.error = err.message || String(err);
            }
            this.logger.error(`Provision failed: ${err.message}`);
        }
    }

    /**
     * Hook called after reset() during provision. Override to restart your service.
     * Default: no-op (the infra-compose router lifecycle hooks handle this for
     * requests that come through the /infra endpoints).
     */
    protected async on_after_reset(): Promise<void> {}

    /**
     * Hook called after switch_profile() during provision. Override to restart your service.
     */
    protected async on_after_switch(): Promise<void> {}

    // ── Job execution ──

    private async run_create_job(job_id: string, fixture_type: string, fixture_id: string, force_adhoc: boolean) {
        try {
            const parsed = new URL(this.ctrl_config.mongo_uri.replace('mongodb://', 'http://'));
            const mongo_host = parsed.hostname;
            const mongo_port = parseInt(parsed.port || '27017', 10);
            const sql_host_str = this.ctrl_config.sql_host ?? 'localhost:3306';
            const sql_parts = sql_host_str.split(':');
            const sql_host: string = sql_parts[0] || 'localhost';
            const sql_port = parseInt(sql_parts[1] || '3306', 10);

            const creator = this.fixture_types[fixture_type]?.creator;

            let result: any;
            if (creator) {
                await this.append_output(job_id, `Using TS creator for ${fixture_type}`);
                result = await creator({
                    fixture_id, mongo_host, mongo_port, sql_host, sql_port, force_adhoc,
                });
            } else {
                await this.append_output(job_id, `Using bash script for ${fixture_type}`);
                await this.run_bash_create(
                    job_id, fixture_type, fixture_id,
                    `${mongo_host}:${mongo_port}`, `${sql_host}:${sql_port}`, force_adhoc,
                );
                result = { exit_code: 0, fixture_id };
            }

            // Shared post-create: snapshot, publish SSM, mark complete
            await this.append_output(job_id, `Saving snapshot as profile: ${fixture_id}`);
            await snapshot({ profile: fixture_id, services: this.services_to_snapshot, force: true });
            if (this.ctrl_config.site_url) {
                await this.append_output(job_id, 'Publishing playwright env to SSM...');
                await this.publish_playwright_env(fixture_id, this.ctrl_config.site_url);
                await this.publish_capabilities(fixture_id, fixture_type);
            }
            await this.jobs_collection.updateOne(
                { _id: job_id } as any,
                { $set: { status: 'completed', completed_at: new Date(), result } },
            );
        } catch (err: any) {
            await this.jobs_collection.updateOne(
                { _id: job_id } as any,
                { $set: { status: 'failed', completed_at: new Date(), error_message: err.message || String(err) } },
            );
        }
    }

    private run_bash_create(
        job_id: string, fixture_type: string, _fixture_id: string,
        mongo_host: string, sql_host: string, force_adhoc: boolean,
    ): Promise<void> {
        return new Promise((done, fail) => {
            const script = path_resolve(this.fixtures_dir, `create-fixture-${fixture_type}.sh`);
            const args = [script, '--mongo-host', mongo_host, '--sql-host', sql_host];
            if (force_adhoc) args.push('--force-adhoc');

            const child = child_spawn('bash', args, { env: process.env });
            const stderr_chunks: string[] = [];

            child.stdout?.on('data', (data: Buffer) => {
                this.append_output(job_id, data.toString().trim());
            });
            child.stderr?.on('data', (data: Buffer) => {
                const text = data.toString().trim();
                stderr_chunks.push(text);
                this.append_output(job_id, `[stderr] ${text}`);
            });

            child.on('close', async (code: number | null) => {
                if (code === 0) {
                    done();
                } else {
                    const last_stderr = stderr_chunks.slice(-3).join('\n').trim();
                    const error_msg = last_stderr
                        ? `Exit code ${code}: ${last_stderr}`
                        : `Script exited with code ${code}`;
                    fail(new Error(error_msg));
                }
            });
        });
    }

    private async append_output(job_id: string, line: string) {
        await this.jobs_collection.updateOne(
            { _id: job_id } as any,
            { $push: { output: line } as any },
        );
    }

    // ── SSM publishing ──

    private async publish_playwright_env(fixture_id: string, base_url: string) {
        try {
            const playwright_data = await this.build_playwright_export(fixture_id, base_url);
            if (!playwright_data.ok) {
                this.logger.warn(`publish_playwright_env: skipped — ${playwright_data.error}`);
                return;
            }

            const param_name = `${this.ssm_prefix}/playwright-env`;
            const ssm = await this.get_ssm();
            const mod = await import('@aws-sdk/client-ssm' as string);
            await ssm.send(new mod.PutParameterCommand({
                Name: param_name,
                Value: JSON.stringify(playwright_data),
                Type: 'String',
                Overwrite: true,
            }));
            this.logger.info(`Published playwright env to SSM: ${param_name}`);
        } catch (err: any) {
            this.logger.warn(`publish_playwright_env failed: ${err.message}`);
        }
    }

    private async publish_capabilities(fixture_id: string, fixture_type: string) {
        try {
            const capabilities = this.fixture_capabilities[fixture_type] || [];
            const param_name = `${this.ssm_prefix}/capabilities`;
            const ssm = await this.get_ssm();
            const mod = await import('@aws-sdk/client-ssm' as string);
            await ssm.send(new mod.PutParameterCommand({
                Name: param_name,
                Value: JSON.stringify({
                    active_profile: fixture_id,
                    fixture_type,
                    capabilities,
                    updated_at: new Date().toISOString(),
                }),
                Type: 'String',
                Overwrite: true,
            }));
            this.logger.info(`Published capabilities to SSM: ${param_name}`);
        } catch (err: any) {
            this.logger.warn(`publish_capabilities failed: ${err.message}`);
        }
    }

    // ── Readiness ──

    @Get('/readiness')
    async readiness() {
        const active = get_active_profile();

        let has_playwright_env = false;
        try {
            const ssm = await this.get_ssm();
            const mod = await import('@aws-sdk/client-ssm' as string);
            await ssm.send(new mod.GetParameterCommand({
                Name: `${this.ssm_prefix}/playwright-env`,
            }));
            has_playwright_env = true;
        } catch { /* parameter doesn't exist yet */ }

        return {
            ok: true,
            vm_name: this.vm_name,
            active_profile: active,
            has_playwright_env,
        };
    }

    // ── Credential export ──

    @Get('/export-playwright')
    async export_playwright(
        @QueryParam('fixture_id') fixture_id: string,
        @QueryParam('base_url') base_url: string,
        @QueryParam('password') password?: string,
    ) {
        if (!fixture_id) {
            return { ok: false, error: 'fixture_id query param is required' };
        }
        if (!base_url) {
            return { ok: false, error: 'base_url query param is required' };
        }
        return this.build_playwright_export(fixture_id, base_url, password || this.default_password);
    }

    protected async build_playwright_export(fixture_id: string, base_url: string, password?: string): Promise<any> {
        const pw = password || this.default_password;

        const is_active = fixture_id === 'active' || fixture_id === '*';
        const doc = is_active
            ? await this.metadata_collection.findOne({}, { sort: { _id: -1 } })
            : await this.metadata_collection.findOne({ fixture_id });
        if (!doc) {
            return { ok: false, error: `Fixture '${fixture_id}' not found in ${this.metadata_collection_name}` };
        }

        const metadata = doc as any;
        const user_ids: string[] = metadata.users || [];
        const user_roles: Record<string, string> = metadata.user_roles || {};
        const user_emails: Record<string, string> = metadata.user_emails || {};

        const mappings = this.role_mappings;
        const suites = this.suite_roles;

        const credentials_by_role = new Map<string, { username: string; password: string; user_type: string }[]>();

        for (const user_id of user_ids) {
            const domain_role = user_roles[user_id];
            const login = user_emails[user_id];
            if (!login || !domain_role) continue;

            const playwright_roles = mappings[domain_role];
            if (!playwright_roles) continue;

            for (const pw_role of playwright_roles) {
                if (!credentials_by_role.has(pw_role)) credentials_by_role.set(pw_role, []);
                credentials_by_role.get(pw_role)!.push({ username: login, password: pw, user_type: pw_role });
            }
        }

        const user_logins: Record<string, Record<string, { username: string; password: string; user_type: string }[]>> = {};
        for (const [suite, roles] of Object.entries(suites)) {
            const suite_data: Record<string, { username: string; password: string; user_type: string }[]> = {};
            for (const role of roles) {
                const creds = credentials_by_role.get(role);
                if (creds && creds.length > 0) suite_data[role] = creds;
            }
            if (Object.keys(suite_data).length > 0) user_logins[suite] = suite_data;
        }

        const user_names: Record<string, { name_first: string; name_last: string }> = metadata.user_names || {};
        const organization = metadata.org_display_name
            ? { id: (metadata.organizations || [])[0] || null, display_name: metadata.org_display_name }
            : null;

        const fixture_data = {
            organization,
            programs: metadata.program_display_data || [],
            users: Object.entries(user_names).map(([user_id, names]) => ({
                user_id,
                name_first: (names as any).name_first,
                name_last: (names as any).name_last,
                display_name: `${(names as any).name_first} ${(names as any).name_last}`.trim(),
                email: user_emails[user_id] || null,
                role: user_roles[user_id] || null,
            })),
        };

        return { ok: true, user_logins, baseUrl: base_url, fixture_data };
    }
}
