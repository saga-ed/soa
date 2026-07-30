/**
 * `describeError` — the fix for connection failures logging as `{}`.
 *
 * The bug: `JSON.stringify(new Error('boom'))` is `"{}"`, because an Error's
 * `message`/`name`/`stack` are non-enumerable. Every RabbitMQ connect failure
 * therefore logged `Error connecting to RabbitMQ: {}`, making an auth
 * rejection, a DNS miss and a TLS failure indistinguishable. These tests pin
 * the property that matters: the log line must contain the actual cause.
 */
import { describe, it, expect } from 'vitest';
import { describeError } from '../src/connection-manager.js';

describe('describeError', () => {
  it('renders an Error with its message — NOT "{}"', () => {
    const out = describeError(new Error('handshake failed'));
    expect(out).toContain('handshake failed');
    expect(out).not.toBe('{}');
  });

  it('is the regression guard: JSON.stringify would have returned "{}" here', () => {
    // Documents the exact defect, so a refactor back to stringify fails loudly.
    const err = new Error('ECONNREFUSED');
    expect(JSON.stringify(err)).toBe('{}');
    expect(describeError(err)).toContain('ECONNREFUSED');
  });

  it('surfaces the errno-style fields Node/amqplib attach', () => {
    // These are what distinguish "wrong host" from "refused" from "reset" —
    // the whole reason a bare message is not enough.
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND broker'), {
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
    });
    const out = describeError(err);
    expect(out).toContain('code=ENOTFOUND');
    expect(out).toContain('errno=-3008');
    expect(out).toContain('syscall=getaddrinfo');
  });

  it('includes the error name so the class is visible', () => {
    class AmqpAuthError extends Error {
      override readonly name = 'AmqpAuthError';
    }
    expect(describeError(new AmqpAuthError('ACCESS_REFUSED'))).toContain('AmqpAuthError');
  });

  it('unwraps `cause` — amqplib hides the real failure there', () => {
    // An auth rejection otherwise reads only as a generic connection close.
    const err = new Error('Connection closed', {
      cause: Object.assign(new Error('ACCESS_REFUSED - Login was refused'), { code: 403 }),
    });
    const out = describeError(err);
    expect(out).toContain('Connection closed');
    expect(out).toContain('ACCESS_REFUSED');
    expect(out).toContain('code=403');
  });

  it('omits absent optional fields rather than printing undefined', () => {
    const out = describeError(new Error('plain'));
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('code=');
  });

  it('handles non-Error throws', () => {
    expect(describeError('just a string')).toBe('just a string');
    expect(describeError({ weird: true })).toContain('weird');
  });

  it('never returns undefined, even for values stringify cannot represent', () => {
    // JSON.stringify(Symbol()) is undefined — a bare template literal would
    // then log the string "undefined".
    expect(describeError(Symbol('nope'))).toBeTypeOf('string');
    expect(describeError(undefined)).toBeTypeOf('string');
  });
});
