import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    DuplicateHandlerError,
    buildHandlerMap,
    eventKey,
    type EventHandler,
} from '../consumer.js';

const noopHandle: EventHandler<unknown>['handle'] = async () => {};

function makeHandler(eventType: string, eventVersion: number): EventHandler<unknown> {
    return {
        eventType,
        eventVersion,
        payloadSchema: z.unknown(),
        handle: noopHandle,
    };
}

describe('eventKey', () => {
    it('formats type and version as "<type>.v<version>"', () => {
        expect(eventKey('iam.user.created', 1)).toBe('iam.user.created.v1');
    });

    it('produces distinct keys across versions of the same type', () => {
        expect(eventKey('iam.user.created', 1)).not.toBe(
            eventKey('iam.user.created', 2),
        );
    });
});

describe('buildHandlerMap', () => {
    it('indexes handlers by derived eventKey', () => {
        const h = makeHandler('iam.user.created', 1);
        const map = buildHandlerMap([h]);
        expect(map.get(eventKey('iam.user.created', 1))).toBe(h);
    });

    it('throws DuplicateHandlerError on (type, version) collision', () => {
        const h1 = makeHandler('iam.user.created', 1);
        const h2 = makeHandler('iam.user.created', 1);
        expect(() => buildHandlerMap([h1, h2])).toThrow(DuplicateHandlerError);
    });

    it('allows same eventType across different versions', () => {
        const h1 = makeHandler('iam.user.created', 1);
        const h2 = makeHandler('iam.user.created', 2);
        const map = buildHandlerMap([h1, h2]);
        expect(map.size).toBe(2);
    });

    it('returns an empty map for an empty handler list', () => {
        const map = buildHandlerMap([]);
        expect(map.size).toBe(0);
    });
});
