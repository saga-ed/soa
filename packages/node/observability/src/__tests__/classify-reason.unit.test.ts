import { describe, expect, it } from 'vitest';
import { classifyReason } from '../metrics.js';

describe('classifyReason', () => {
    it.each([
        ['Connection timed out at 10.0.1.5', 'timeout'],
        ['ETIMEDOUT', 'timeout'],
        ['ECONNREFUSED 127.0.0.1:5432', 'network'],
        ['getaddrinfo ENOTFOUND broker.local', 'network'],
        ['Malformed envelope: invalid uuid', 'malformed_envelope'],
        ['No handler registered for event key "iam.user.created.v9"', 'no_handler'],
        ['ZodError: Required at "payload.id"', 'validation'],
        ['Invalid payload: missing field', 'validation'],
        ['channel closed while awaiting drain', 'broker_closed'],
        ['connection closed by remote', 'broker_closed'],
        ['duplicate key value violates unique constraint', 'db_conflict'],
        ['Some completely novel error 12345', 'other'],
    ])('classifies %j as %s', (reason, expected) => {
        expect(classifyReason(reason)).toBe(expected);
    });

    it('is case-insensitive', () => {
        expect(classifyReason('TIMEOUT')).toBe('timeout');
        expect(classifyReason('econnreset')).toBe('network');
    });
});
