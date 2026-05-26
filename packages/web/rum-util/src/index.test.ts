import { afterEach, describe, expect, it, vi } from 'vitest';
import { datadogRum } from '@datadog/browser-rum';
import {
  initRum,
  setRumUser,
  clearRumUser,
  setRumGlobalContextProperty,
  addRumError,
  addRumAction,
  isInitialized,
  __resetForTest,
} from './index.js';

vi.mock('@datadog/browser-rum', () => ({
  datadogRum: {
    init: vi.fn(),
    setUserProperty: vi.fn(),
    clearUser: vi.fn(),
    setGlobalContextProperty: vi.fn(),
    addError: vi.fn(),
    addAction: vi.fn(),
  },
}));

afterEach(() => {
  __resetForTest();
  vi.clearAllMocks();
});

describe('initRum', () => {
  it('initializes with merged defaults when applicationId + clientToken present', () => {
    const ok = initRum({
      service: 'test_svc',
      applicationId: 'app-123',
      clientToken: 'pub-abc',
      env: 'dev',
      version: '0.0.1',
    });
    expect(ok).toBe(true);
    expect(isInitialized()).toBe(true);
    expect(datadogRum.init).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: 'app-123',
        clientToken: 'pub-abc',
        site: 'datadoghq.com',
        service: 'test_svc',
        env: 'dev',
        version: '0.0.1',
        sessionSampleRate: 100,
        sessionReplaySampleRate: 5,
        defaultPrivacyLevel: 'mask',
      })
    );
  });

  it('no-ops silently when applicationId is empty', () => {
    const ok = initRum({
      service: 'test_svc',
      applicationId: '',
      clientToken: 'pub-abc',
      env: 'dev',
      version: '0.0.1',
    });
    expect(ok).toBe(false);
    expect(isInitialized()).toBe(false);
    expect(datadogRum.init).not.toHaveBeenCalled();
  });

  it('is idempotent — second call returns true without re-init', () => {
    initRum({ service: 's', applicationId: 'a', clientToken: 'b', env: 'dev', version: '0' });
    initRum({ service: 's', applicationId: 'a', clientToken: 'b', env: 'dev', version: '0' });
    expect(datadogRum.init).toHaveBeenCalledTimes(1);
  });
});

describe('setRumUser', () => {
  it('calls setUserProperty per defined field, skips undefined', () => {
    initRum({ service: 's', applicationId: 'a', clientToken: 'b', env: 'dev', version: '0' });
    setRumUser({ id: 'u1', name: 'Alice', org: undefined, role: 'TUTOR' });
    expect(datadogRum.setUserProperty).toHaveBeenCalledWith('id', 'u1');
    expect(datadogRum.setUserProperty).toHaveBeenCalledWith('name', 'Alice');
    expect(datadogRum.setUserProperty).toHaveBeenCalledWith('role', 'TUTOR');
    expect(datadogRum.setUserProperty).not.toHaveBeenCalledWith('org', expect.anything());
  });

  it('is a no-op before init', () => {
    setRumUser({ id: 'u1' });
    expect(datadogRum.setUserProperty).not.toHaveBeenCalled();
  });
});

describe('addRumError / addRumAction', () => {
  it('tags addError with source = service', () => {
    initRum({ service: 'saga_dash', applicationId: 'a', clientToken: 'b', env: 'dev', version: '0' });
    addRumError(new Error('boom'), { tag: 'unit-test' });
    expect(datadogRum.addError).toHaveBeenCalledWith(
      expect.any(Error),
      { source: 'saga_dash', tag: 'unit-test' }
    );
  });

  it('tags addAction with source = service', () => {
    initRum({ service: 'saga_dash', applicationId: 'a', clientToken: 'b', env: 'dev', version: '0' });
    addRumAction('login_succeeded', { user_id: 'u1' });
    expect(datadogRum.addAction).toHaveBeenCalledWith(
      'login_succeeded',
      { source: 'saga_dash', user_id: 'u1' }
    );
  });

  it('caller-supplied source cannot override the service tag', () => {
    initRum({ service: 'saga_dash', applicationId: 'a', clientToken: 'b', env: 'dev', version: '0' });
    addRumError(new Error('x'), { source: 'override' });
    expect(datadogRum.addError).toHaveBeenCalledWith(expect.any(Error), { source: 'saga_dash' });
  });

  it('is a no-op before init', () => {
    addRumError(new Error('x'));
    addRumAction('foo');
    expect(datadogRum.addError).not.toHaveBeenCalled();
    expect(datadogRum.addAction).not.toHaveBeenCalled();
  });
});

describe('setRumGlobalContextProperty / clearRumUser', () => {
  it('pass through when initialized', () => {
    initRum({ service: 's', applicationId: 'a', clientToken: 'b', env: 'dev', version: '0' });
    setRumGlobalContextProperty('selected_program_id', 'prog-1');
    clearRumUser();
    expect(datadogRum.setGlobalContextProperty).toHaveBeenCalledWith('selected_program_id', 'prog-1');
    expect(datadogRum.clearUser).toHaveBeenCalled();
  });

  it('are no-ops before init', () => {
    setRumGlobalContextProperty('x', 1);
    clearRumUser();
    expect(datadogRum.setGlobalContextProperty).not.toHaveBeenCalled();
    expect(datadogRum.clearUser).not.toHaveBeenCalled();
  });
});
