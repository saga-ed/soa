import { describe, it, expect } from 'vitest';
import { isHealthCheckRequest } from './health-path.js';

describe('isHealthCheckRequest', () => {
    it.each(['/health', '/health/ready', '/health/deep', '/health/live', '/health/ready?x=1'])(
        'matches %s',
        (url) => expect(isHealthCheckRequest({ url })).toBe(true),
    );

    it.each(['/healthz', '/api/health', '/healthcheck', '/', '', undefined])(
        'does not match %s',
        (url) => expect(isHealthCheckRequest({ url })).toBe(false),
    );
});
