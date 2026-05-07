import { describe, expect, it } from 'vitest';
import {
    decideTwoHeaders,
    HEADER_AUTHORIZATION,
    HEADER_SAGA_CALLER,
    isComplete,
    parseTwoHeaders,
    TWO_HEADERS_METRIC,
    TwoHeadersModeSchema,
} from '../two-headers.js';

describe('parseTwoHeaders', () => {
    const validCaller = 'spiffe://saga.dev/programs-api';
    const validBearer = 'Bearer eyJhbGciOiJFUzI1NiJ9.payload.signature';

    it('returns ok with both headers present and well-formed', () => {
        const result = parseTwoHeaders({
            [HEADER_SAGA_CALLER]: validCaller,
            [HEADER_AUTHORIZATION]: validBearer,
        });
        expect(result.status).toBe('ok');
        expect(isComplete(result)).toBe(true);
        expect(result.callerSpiffeId).toBe(validCaller);
        expect(result.bearerToken).toBe(
            'eyJhbGciOiJFUzI1NiJ9.payload.signature',
        );
        expect(result.issues).toHaveLength(0);
    });

    it('handles lowercase header keys (Node http normalizes)', () => {
        const result = parseTwoHeaders({
            'x-saga-caller': validCaller,
            authorization: validBearer,
        });
        expect(result.status).toBe('ok');
    });

    it('reports caller missing', () => {
        const result = parseTwoHeaders({
            [HEADER_AUTHORIZATION]: validBearer,
        });
        expect(result.status).toBe('caller_missing');
        expect(result.callerSpiffeId).toBeNull();
        expect(result.bearerToken).toBe(
            'eyJhbGciOiJFUzI1NiJ9.payload.signature',
        );
    });

    it('reports caller malformed', () => {
        const result = parseTwoHeaders({
            [HEADER_SAGA_CALLER]: 'not-a-spiffe-id',
            [HEADER_AUTHORIZATION]: validBearer,
        });
        expect(result.status).toBe('caller_malformed');
        expect(result.issues[0]).toContain('not a valid SPIFFE ID');
    });

    it('reports subject missing', () => {
        const result = parseTwoHeaders({
            [HEADER_SAGA_CALLER]: validCaller,
        });
        expect(result.status).toBe('subject_missing');
        expect(result.bearerToken).toBeNull();
    });

    it('reports subject malformed (non-Bearer scheme)', () => {
        const result = parseTwoHeaders({
            [HEADER_SAGA_CALLER]: validCaller,
            [HEADER_AUTHORIZATION]: 'Basic dXNlcjpwYXNz',
        });
        expect(result.status).toBe('subject_malformed');
    });

    it('returns the first detected status when both sides fail', () => {
        const result = parseTwoHeaders({});
        expect(result.status).toBe('caller_missing');
        expect(result.issues).toHaveLength(2);
    });

    it('works with the Web Headers interface', () => {
        const headers = new Headers({
            [HEADER_SAGA_CALLER]: validCaller,
            [HEADER_AUTHORIZATION]: validBearer,
        });
        const result = parseTwoHeaders(headers);
        expect(result.status).toBe('ok');
    });

    it('strips Bearer prefix case-insensitively', () => {
        const result = parseTwoHeaders({
            [HEADER_SAGA_CALLER]: validCaller,
            [HEADER_AUTHORIZATION]: 'bearer abc.def.ghi',
        });
        expect(result.status).toBe('ok');
        expect(result.bearerToken).toBe('abc.def.ghi');
    });

    it('treats array header values as the first element', () => {
        const result = parseTwoHeaders({
            [HEADER_SAGA_CALLER]: [validCaller, 'extra'],
            [HEADER_AUTHORIZATION]: validBearer,
        });
        expect(result.status).toBe('ok');
        expect(result.callerSpiffeId).toBe(validCaller);
    });
});

describe('TwoHeadersModeSchema', () => {
    it('accepts the three modes', () => {
        expect(TwoHeadersModeSchema.safeParse('off').success).toBe(true);
        expect(TwoHeadersModeSchema.safeParse('shadow').success).toBe(true);
        expect(TwoHeadersModeSchema.safeParse('enforce').success).toBe(true);
    });

    it('rejects unknown modes', () => {
        expect(TwoHeadersModeSchema.safeParse('strict').success).toBe(false);
    });
});

describe('decideTwoHeaders', () => {
    const validCaller = 'spiffe://saga.dev/programs-api';
    const validBearer = 'Bearer eyJhbGciOiJFUzI1NiJ9.payload.signature';

    const completeHeaders = {
        [HEADER_SAGA_CALLER]: validCaller,
        [HEADER_AUTHORIZATION]: validBearer,
    };

    it('exports the canonical metric name', () => {
        expect(TWO_HEADERS_METRIC).toBe('saga_two_headers_missing_total');
    });

    it('off mode always allows', () => {
        const d = decideTwoHeaders({}, 'off');
        expect(d.action).toBe('allow');
        expect(d.metricReason).toBeUndefined();
    });

    it('off mode allows even malformed headers', () => {
        const d = decideTwoHeaders(
            { [HEADER_SAGA_CALLER]: 'garbage' },
            'off',
        );
        expect(d.action).toBe('allow');
    });

    it('shadow mode allows complete headers', () => {
        const d = decideTwoHeaders(completeHeaders, 'shadow');
        expect(d.action).toBe('allow');
        expect(d.metricReason).toBeUndefined();
    });

    it('shadow mode emits log + metric on missing caller', () => {
        const d = decideTwoHeaders(
            { [HEADER_AUTHORIZATION]: validBearer },
            'shadow',
        );
        expect(d.action).toBe('log');
        expect(d.metricReason).toBe('caller_missing');
    });

    it('shadow mode emits log + metric on malformed caller', () => {
        const d = decideTwoHeaders(
            { [HEADER_SAGA_CALLER]: 'not-spiffe', [HEADER_AUTHORIZATION]: validBearer },
            'shadow',
        );
        expect(d.action).toBe('log');
        expect(d.metricReason).toBe('caller_malformed');
    });

    it('enforce mode allows complete headers', () => {
        const d = decideTwoHeaders(completeHeaders, 'enforce');
        expect(d.action).toBe('allow');
    });

    it('enforce mode rejects on missing subject', () => {
        const d = decideTwoHeaders(
            { [HEADER_SAGA_CALLER]: validCaller },
            'enforce',
        );
        expect(d.action).toBe('reject');
        expect(d.metricReason).toBe('subject_missing');
    });

    it('enforce mode rejects on malformed subject', () => {
        const d = decideTwoHeaders(
            {
                [HEADER_SAGA_CALLER]: validCaller,
                [HEADER_AUTHORIZATION]: 'Basic dXNlcjpwYXNz',
            },
            'enforce',
        );
        expect(d.action).toBe('reject');
        expect(d.metricReason).toBe('subject_malformed');
    });

    it('parse result is always exposed for caller introspection', () => {
        const d = decideTwoHeaders(completeHeaders, 'shadow');
        expect(d.parse.callerSpiffeId).toBe(validCaller);
        expect(d.parse.bearerToken).toBeTruthy();
    });
});
