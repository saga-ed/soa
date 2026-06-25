import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { REDACT_PATHS } from '../pino-logger.js';

// These tests guard two fleet-wide risks introduced by the redaction config:
//  1. A malformed fast-redact path throws at Pino CONSTRUCTION → that would
//     crash EVERY service at startup. The construction test pins that.
//  2. A regression that drops/weakens redaction → PII reaches the log sink.
//
// We exercise REDACT_PATHS through a real Pino instance (the same `redact`
// option PinoLogger wires into baseOptions) writing to an in-memory stream, so
// we assert the actual serialized output rather than reaching into internals.

function makeCapturingLogger() {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            lines.push(JSON.parse(chunk.toString()));
            cb();
        },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinoFn: any = (pino as any).default ?? pino;
    const logger = pinoFn(
        { level: 'info', redact: { paths: REDACT_PATHS } },
        stream,
    );
    return { logger, lines };
}

describe('REDACT_PATHS', () => {
    it('does not throw at Pino construction (fleet startup-crash guard)', () => {
        expect(() => makeCapturingLogger()).not.toThrow();
    });

    it('redacts top-level and one-level-nested PII; keeps non-PII', () => {
        const { logger, lines } = makeCapturingLogger();
        logger.info(
            {
                email: 'a@b.com',
                password: 'hunter2',
                token: 'abc',
                body: { ssn: '078-05-1120' },
                user: { email: 'n@s.edu', id: 123, role: 'teacher' },
                req: { body: { firstName: 'Jo' }, headers: { authorization: 'Bearer x' } },
            },
            'msg',
        );
        const log = lines[0]!;

        // top-level PII censored
        expect(log.email).toBe('[Redacted]');
        expect(log.password).toBe('[Redacted]');
        expect(log.token).toBe('[Redacted]');
        expect(log.body).toBe('[Redacted]'); // top-level body (the #6 gap)

        // one-level-nested PII censored
        const user = log.user as Record<string, unknown>;
        expect(user.email).toBe('[Redacted]');
        // non-PII siblings survive (field-level, not wholesale-object, redaction)
        expect(user.id).toBe(123);
        expect(user.role).toBe('teacher');

        // wholesale req.body + auth header censored
        const req = log.req as Record<string, unknown>;
        expect(req.body).toBe('[Redacted]');
        const headers = req.headers as Record<string, unknown>;
        expect(headers.authorization).toBe('[Redacted]');
    });

    it('characterization: two-level-deep PII is NOT redacted (documented limit)', () => {
        // The comment in pino-logger.ts states redaction reaches ONE level of
        // nesting only (no `*.*.x`). This pins that boundary so a future change
        // is a deliberate decision, not a silent regression.
        const { logger, lines } = makeCapturingLogger();
        logger.info({ a: { b: { email: 'deep@b.com' } } }, 'msg');
        const a = lines[0]!.a as Record<string, Record<string, unknown>>;
        expect(a.b.email).toBe('deep@b.com'); // NOT redacted (two levels deep)
    });
});
