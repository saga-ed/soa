import { describe, it, expect } from 'vitest';
import type { ProvisionState, ProvisionStatus } from '../types.js';

describe('ProvisionState', () => {
    function make_state(status: ProvisionStatus = 'idle'): ProvisionState {
        return {
            status,
            fixture_type: 'iam-pgm-small',
            fixture_id: 'iam-pgm-small',
            started_at: new Date(),
            completed_at: null,
            error: null,
            user_count: null,
        };
    }

    it('should start in resetting state', () => {
        const state = make_state('resetting');
        expect(state.status).toBe('resetting');
        expect(state.completed_at).toBeNull();
    });

    it('should transition through provision lifecycle', () => {
        const state = make_state('resetting');
        const transitions: ProvisionStatus[] = ['creating', 'switching', 'verifying', 'ready'];

        for (const next of transitions) {
            state.status = next;
            expect(state.status).toBe(next);
        }

        state.completed_at = new Date();
        state.user_count = 27;
        expect(state.status).toBe('ready');
        expect(state.user_count).toBe(27);
    });

    it('should transition to failed from any state', () => {
        for (const from of ['resetting', 'creating', 'switching', 'verifying'] as ProvisionStatus[]) {
            const state = make_state(from);
            state.status = 'failed';
            state.error = 'something went wrong';
            state.completed_at = new Date();
            expect(state.status).toBe('failed');
            expect(state.error).toBe('something went wrong');
        }
    });

    it('should block new provision when in progress', () => {
        const active_states: ProvisionStatus[] = ['resetting', 'creating', 'switching', 'verifying'];
        for (const status of active_states) {
            const state = make_state(status);
            const can_start = ['ready', 'failed', 'idle'].includes(state.status);
            expect(can_start).toBe(false);
        }
    });

    it('should allow new provision when ready or failed', () => {
        for (const status of ['ready', 'failed'] as ProvisionStatus[]) {
            const state = make_state(status);
            const can_start = ['ready', 'failed', 'idle'].includes(state.status);
            expect(can_start).toBe(true);
        }
    });
});
