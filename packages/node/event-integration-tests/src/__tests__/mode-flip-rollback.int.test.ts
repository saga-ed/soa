import { describe, expect, it } from 'vitest';
import {
    decideSignature,
    signEnvelope,
    type EventEnvelope,
    type SignatureKeyResolver,
    type SignatureMode,
} from '@saga-ed/soa-event-envelope';
import {
    decideTwoHeaders,
    type TwoHeadersMode,
} from '@saga-ed/soa-auth-contracts';

/**
 * Mode-flip rollback safety per the rollout plan.
 *
 * The shadow→enforce migration is reversible by design: an operator
 * flips a flag and traffic adjusts on the next request. This test pins
 * the invariant that *no state is cached on the verifier path* — the
 * mode parameter is honored on every call, so rollback works without
 * a process restart.
 *
 * Both seams use a "decide is pure" pattern: the decision is computed
 * fresh per call from (input, configured_mode, configured_resolver).
 * That's why mode flips are safe — no closure captures last-seen mode.
 */

const KEY_ID = 'rollback-key';
const SECRET = 'a'.repeat(64);

function makeSignedEnvelope(payload: object): EventEnvelope {
    const base: EventEnvelope = {
        eventId: '00000000-0000-4000-8000-000000000001',
        eventType: 'identity.user.created',
        eventVersion: 1,
        aggregateType: 'user',
        aggregateId: 'agg-1',
        occurredAt: new Date().toISOString(),
        payload: payload as Record<string, unknown>,
    };
    return signEnvelope(base, { keyId: KEY_ID, secret: SECRET });
}

describe('signature mode flip: enforce → shadow → enforce within one process', () => {
    it('the same forged envelope produces reject under enforce, log under shadow — no state pin', async () => {
        const forged = makeSignedEnvelope({ userId: 'forged' });
        // Resolver does NOT know the producer key, simulating the
        // "consumer hasn't been re-keyed yet" rollback scenario.
        const resolver: SignatureKeyResolver = () => null;

        const sequence: SignatureMode[] = [
            'enforce',
            'shadow',
            'enforce',
            'off',
            'enforce',
        ];
        const decisions = await Promise.all(
            sequence.map((m) => decideSignature(forged, resolver, m)),
        );
        expect(decisions.map((d) => d.action)).toEqual([
            'reject',
            'log',
            'reject',
            'allow',
            'reject',
        ]);
        expect(decisions[3]!.status).toBe('unverified');
    });

    it('a valid envelope under matching key: every mode allows', async () => {
        const env = makeSignedEnvelope({ userId: 'good' });
        const resolver: SignatureKeyResolver = (kid) =>
            kid === KEY_ID ? SECRET : null;
        for (const mode of ['off', 'shadow', 'enforce'] as SignatureMode[]) {
            const d = await decideSignature(env, resolver, mode);
            expect(d.action).toBe('allow');
        }
    });

    it('mode parameter is read on every call — closure does not capture', async () => {
        // Build the resolver and envelope once, then flip the mode many
        // times. If anything cached the first-seen mode, behavior would
        // diverge. We assert it doesn't.
        const env = makeSignedEnvelope({ userId: 'cap' });
        const resolver: SignatureKeyResolver = () => null;
        const flips = 50;
        const expected: Array<'allow' | 'log' | 'reject'> = [];
        const observed: Array<'allow' | 'log' | 'reject'> = [];
        for (let i = 0; i < flips; i++) {
            const m: SignatureMode = i % 2 === 0 ? 'shadow' : 'enforce';
            expected.push(m === 'shadow' ? 'log' : 'reject');
            const d = await decideSignature(env, resolver, m);
            observed.push(d.action);
        }
        expect(observed).toEqual(expected);
    });
});

describe('two-headers mode flip: enforce → shadow → enforce within one process', () => {
    it('same incomplete header set: reject under enforce, log under shadow', () => {
        const incomplete = {
            // Missing X-Saga-Caller; Authorization present but not Bearer
            authorization: 'Basic dXNlcjpwYXNz',
        } as Record<string, string>;

        const sequence: TwoHeadersMode[] = ['enforce', 'shadow', 'enforce', 'off'];
        const decisions = sequence.map((m) => decideTwoHeaders(incomplete, m));
        expect(decisions.map((d) => d.action)).toEqual([
            'reject',
            'log',
            'reject',
            'allow',
        ]);
        expect(decisions[0]!.metricReason).toBe('caller_missing');
        expect(decisions[1]!.metricReason).toBe('caller_missing');
        expect(decisions[3]!.metricReason).toBeUndefined();
    });

    it('complete header set: every mode allows', () => {
        const complete = {
            'x-saga-caller': 'spiffe://saga.dev/test-client',
            authorization: 'Bearer eyJ.fake.jwt',
        };
        for (const mode of ['off', 'shadow', 'enforce'] as TwoHeadersMode[]) {
            const d = decideTwoHeaders(complete, mode);
            expect(d.action).toBe('allow');
        }
    });

    it('rapid mode flipping under load: behavior tracks the current flag', () => {
        const incomplete = {
            authorization: 'Basic xyz',
        };
        const flips = 100;
        const observed: Array<'allow' | 'log' | 'reject'> = [];
        for (let i = 0; i < flips; i++) {
            const m: TwoHeadersMode = i % 2 === 0 ? 'shadow' : 'enforce';
            observed.push(decideTwoHeaders(incomplete, m).action);
        }
        const expected: Array<'allow' | 'log' | 'reject'> = [];
        for (let i = 0; i < flips; i++) {
            expected.push(i % 2 === 0 ? 'log' : 'reject');
        }
        expect(observed).toEqual(expected);
    });
});
