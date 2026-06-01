import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every spawnSync invocation so we can assert the `aws s3 cp` source path.
const spawnSync_calls = [];

vi.mock('child_process', () => ({
    spawnSync: vi.fn((cmd, args) => {
        spawnSync_calls.push([cmd, args]);
        return { status: 0, stdout: '', stderr: '' };
    }),
    spawn: vi.fn(),
}));

// download_profile_seed touches the filesystem to (re)create the seeds dir; stub
// only the mutating calls, keep the rest real so nothing else breaks.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: vi.fn(() => false),
        mkdirSync: vi.fn(),
        readdirSync: vi.fn(() => []),
        rmSync: vi.fn(),
        writeFileSync: vi.fn(),
    };
});

import { download_profile_seed } from '../../src/ec2/profiles.js';

/** The args array of the `aws s3 cp` invocation, if any. */
function awsCpArgs() {
    const call = spawnSync_calls.find(
        ([cmd, args]) => cmd === 'aws' && args[0] === 's3' && args[1] === 'cp',
    );
    return call ? call[1] : null;
}

describe('download_profile_seed — seedFrom source-override', () => {
    beforeEach(() => {
        spawnSync_calls.length = 0;
    });

    it('reads from the DB own name when source_name is absent', () => {
        download_profile_seed({
            name: 'programs-api-sbx',
            profile: 'canonical',
            engine: 'postgres',
            bucket: 'seeds-bkt',
            seeds_base: '/tmp/seeds',
        });
        const args = awsCpArgs();
        expect(args).not.toBeNull();
        // args = ['s3', 'cp', <source>, <dest>]
        expect(args[2]).toBe('s3://seeds-bkt/programs-api-sbx/profile-canonical.sql');
    });

    it('overrides ONLY the S3 source prefix when source_name (seedFrom) is provided', () => {
        download_profile_seed({
            name: 'programs-api-sbx',
            profile: 'canonical',
            engine: 'postgres',
            bucket: 'seeds-bkt',
            seeds_base: '/tmp/seeds',
            source_name: 'programs-api-canonical',
        });
        const args = awsCpArgs();
        expect(args).not.toBeNull();
        // Source comes from the stable template name…
        expect(args[2]).toBe('s3://seeds-bkt/programs-api-canonical/profile-canonical.sql');
        // …but the local seed destination stays keyed by the TARGET db name.
        expect(args[3]).toContain('/tmp/seeds/programs-api-sbx/');
    });
});
