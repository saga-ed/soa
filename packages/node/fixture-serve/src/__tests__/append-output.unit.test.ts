import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('append_output buffering', () => {
    // Test the buffering logic in isolation (same algorithm as AbstractFixtureController)

    let buffers: Map<string, string[]>;
    let timers: Map<string, ReturnType<typeof setInterval>>;
    let flushed: { job_id: string; lines: string[] }[];

    function flush_output(job_id: string) {
        const buffer = buffers.get(job_id);
        if (!buffer || buffer.length === 0) return;
        const lines = buffer.splice(0);
        flushed.push({ job_id, lines });
    }

    function append_output(job_id: string, line: string) {
        let buffer = buffers.get(job_id);
        if (!buffer) {
            buffer = [];
            buffers.set(job_id, buffer);
            const timer = setInterval(() => flush_output(job_id), 2000);
            timers.set(job_id, timer);
        }
        buffer.push(line);
    }

    function finalize_output(job_id: string) {
        const timer = timers.get(job_id);
        if (timer) clearInterval(timer);
        timers.delete(job_id);
        flush_output(job_id);
        buffers.delete(job_id);
    }

    beforeEach(() => {
        vi.useFakeTimers();
        buffers = new Map();
        timers = new Map();
        flushed = [];
    });

    afterEach(() => {
        for (const timer of timers.values()) clearInterval(timer);
        vi.useRealTimers();
    });

    it('should buffer multiple lines before flushing', () => {
        append_output('job1', 'line1');
        append_output('job1', 'line2');
        append_output('job1', 'line3');

        expect(flushed).toHaveLength(0);
        expect(buffers.get('job1')).toHaveLength(3);
    });

    it('should flush on 2-second interval', () => {
        append_output('job1', 'line1');
        append_output('job1', 'line2');

        vi.advanceTimersByTime(2000);

        expect(flushed).toHaveLength(1);
        expect(flushed[0].lines).toEqual(['line1', 'line2']);
        expect(buffers.get('job1')).toHaveLength(0);
    });

    it('should batch multiple intervals', () => {
        append_output('job1', 'a');
        vi.advanceTimersByTime(2000);
        append_output('job1', 'b');
        append_output('job1', 'c');
        vi.advanceTimersByTime(2000);

        expect(flushed).toHaveLength(2);
        expect(flushed[0].lines).toEqual(['a']);
        expect(flushed[1].lines).toEqual(['b', 'c']);
    });

    it('should finalize remaining buffer', () => {
        append_output('job1', 'x');
        append_output('job1', 'y');
        finalize_output('job1');

        expect(flushed).toHaveLength(1);
        expect(flushed[0].lines).toEqual(['x', 'y']);
        expect(buffers.has('job1')).toBe(false);
        expect(timers.has('job1')).toBe(false);
    });

    it('should handle multiple jobs independently', () => {
        append_output('job1', 'a');
        append_output('job2', 'b');

        vi.advanceTimersByTime(2000);

        expect(flushed).toHaveLength(2);
        expect(flushed.find(f => f.job_id === 'job1')?.lines).toEqual(['a']);
        expect(flushed.find(f => f.job_id === 'job2')?.lines).toEqual(['b']);
    });

    it('should not flush empty buffer', () => {
        append_output('job1', 'a');
        vi.advanceTimersByTime(2000); // flushes 'a'
        vi.advanceTimersByTime(2000); // empty buffer, should not add to flushed

        expect(flushed).toHaveLength(1);
    });
});
