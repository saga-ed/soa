import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ spawnSync: vi.fn() }));

import { spawnSync } from 'child_process';
import { cleanup_volume } from '../../src/ec2/volumes.js';

/** aws sub-commands invoked, in order, as 'ec2 <action>' strings. */
function aws_calls() {
    return spawnSync.mock.calls
        .filter(([cmd]) => cmd === 'aws')
        .map(([, args]) => args.slice(0, 2).join(' '));
}

function mock_host({ mounted = false, state = 'available', failing = {} } = {}) {
    spawnSync.mockImplementation((cmd, args) => {
        if (cmd === 'mountpoint') return { status: mounted ? 0 : 1 };
        if (cmd === 'aws') {
            const action = args[1];
            if (failing[action]) return { status: 1, stdout: '', stderr: failing[action] };
            if (action === 'describe-volumes') return { status: 0, stdout: `${state}\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    });
}

describe('cleanup_volume', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('deletes an available volume without detaching or waiting', () => {
        mock_host({ state: 'available' });
        expect(cleanup_volume({ volume_id: 'vol-1', mount_path: '/mnt/data/x', region: 'us-west-2' })).toBe(true);
        expect(aws_calls()).toContain('ec2 delete-volume');
        expect(aws_calls()).not.toContain('ec2 detach-volume');
        expect(aws_calls()).not.toContain('ec2 wait');
    });

    it('detaches, waits, then deletes an in-use volume — in that order', () => {
        mock_host({ state: 'in-use' });
        expect(cleanup_volume({ volume_id: 'vol-1', region: 'us-west-2' })).toBe(true);
        const calls = aws_calls();
        const detach = calls.indexOf('ec2 detach-volume');
        const wait = calls.indexOf('ec2 wait');
        const del = calls.indexOf('ec2 delete-volume');
        expect(detach).toBeGreaterThan(-1);
        expect(detach).toBeLessThan(wait);
        expect(wait).toBeLessThan(del);
    });

    it('also detaches a volume stuck in attaching', () => {
        mock_host({ state: 'attaching' });
        expect(cleanup_volume({ volume_id: 'vol-1', region: 'us-west-2' })).toBe(true);
        expect(aws_calls()).toContain('ec2 detach-volume');
    });

    it('refuses to detach while the mount is still held', () => {
        mock_host({ mounted: true });
        expect(cleanup_volume({ volume_id: 'vol-1', mount_path: '/mnt/data/x', region: 'us-west-2' })).toBe(false);
        expect(aws_calls()).toEqual([]);
    });

    it('treats an already-deleted volume as success', () => {
        mock_host({ failing: { 'describe-volumes': 'An error occurred (InvalidVolume.NotFound) when calling DescribeVolumes' } });
        expect(cleanup_volume({ volume_id: 'vol-1', region: 'us-west-2' })).toBe(true);
        expect(aws_calls()).not.toContain('ec2 delete-volume');
    });

    it('never throws — an aws failure returns false', () => {
        mock_host({ state: 'in-use', failing: { 'detach-volume': 'boom' } });
        let result;
        expect(() => { result = cleanup_volume({ volume_id: 'vol-1', region: 'us-west-2' }); }).not.toThrow();
        expect(result).toBe(false);
    });
});
