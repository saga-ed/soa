import { describe, expect, it } from 'vitest';
import {
  DEPLOYED_ENVS,
  defaultLocalPort,
  isSharedStore,
  mongoParamsFor,
  mongoPasswordHint,
  mongoUrlTemplate,
  parseMongoHosts,
  pickMongoMember,
  rabbitmqCurlHint,
  rabbitmqHost,
  rabbitmqParamsFor,
  rabbitmqPasswordHint,
} from '../index.js';

const HOSTS =
  'ip-172-21-187-81.us-west-2.compute.internal:27017,ip-172-21-187-82.us-west-2.compute.internal:27017,ip-172-21-187-83.us-west-2.compute.internal:27017';

describe('parseMongoHosts', () => {
  it('parses the comma-separated host:port list in order', () => {
    const m = parseMongoHosts(HOSTS);
    expect(m).toHaveLength(3);
    expect(m[0]).toEqual({ host: 'ip-172-21-187-81.us-west-2.compute.internal', port: 27017 });
  });
  it('rejects empty and malformed values', () => {
    expect(() => parseMongoHosts('')).toThrow(/empty/);
    expect(() => parseMongoHosts(' , ')).toThrow(/empty/);
    expect(() => parseMongoHosts('hostonly')).toThrow(/malformed/);
    expect(() => parseMongoHosts('h:abc')).toThrow(/malformed/);
    expect(() => parseMongoHosts('h:99999')).toThrow(/malformed/);
  });
});

describe('pickMongoMember', () => {
  const members = parseMongoHosts(HOSTS);
  it('selects by index', () => expect(pickMongoMember(members, 2).host).toContain('83'));
  it('refuses out-of-range and non-integer indexes', () => {
    expect(() => pickMongoMember(members, 3)).toThrow(/valid: 0\.\.2/);
    expect(() => pickMongoMember(members, -1)).toThrow(/out of range/);
    expect(() => pickMongoMember(members, 1.5)).toThrow(/out of range/);
  });
});

describe('registry gating', () => {
  it('dev has no mongo and refuses; prod has it', () => {
    expect(mongoParamsFor(DEPLOYED_ENVS['dev']!).refusal).toMatch(/no shared MongoDB/);
    expect(mongoParamsFor(DEPLOYED_ENVS['prod']!).params?.readOnlySecret).toBe('prod/mongodb-shared/readonly-password');
  });
  it('training has neither; dev and prod have rabbitmq', () => {
    expect(mongoParamsFor(DEPLOYED_ENVS['training']!).refusal).toBeDefined();
    expect(rabbitmqParamsFor(DEPLOYED_ENVS['training']!).refusal).toMatch(/no shared RabbitMQ/);
    expect(rabbitmqParamsFor(DEPLOYED_ENVS['dev']!).params?.brokerIdParam).toBe('/dev/shared/rabbitmq-broker-id');
    expect(rabbitmqParamsFor(DEPLOYED_ENVS['prod']!).params?.readOnlySecret).toBe('shared-prod-mq-readonly');
  });
});

describe('connection hints', () => {
  it('mongo URL template carries the options and a placeholder, never a password', () => {
    const url = mongoUrlTemplate(27018, '/tmp/ca.pem');
    expect(url).toBe(
      'mongodb://saga_ro:${MONGO_PW}@127.0.0.1:27018/?directConnection=true&readPreference=secondaryPreferred&authSource=admin&tls=true&tlsCAFile=/tmp/ca.pem&tlsAllowInvalidHostnames=true',
    );
  });
  it('password hints fetch at run time and carry the profile', () => {
    const h = mongoPasswordHint('prod/mongodb-shared/readonly-password', 'us-west-2', 'saga-runtime-prod');
    expect(h).toContain('--secret-id prod/mongodb-shared/readonly-password');
    expect(h).toContain('--profile saga-runtime-prod');
    expect(rabbitmqPasswordHint('shared-prod-mq-readonly', 'us-west-2')).not.toContain('--profile');
  });
  it('rabbitmq host and curl hint', () => {
    const host = rabbitmqHost('b-1234', 'us-west-2');
    expect(host).toBe('b-1234.mq.us-west-2.on.aws');
    const curl = rabbitmqCurlHint(host, 15443);
    expect(curl).toContain(`--connect-to ${host}:443:127.0.0.1:15443`);
    expect(curl).toContain('${MQ_PW}');
  });
});

describe('default local ports', () => {
  it('is store-dependent', () => {
    expect(defaultLocalPort('iam')).toBe(15432);
    expect(defaultLocalPort('mongo')).toBe(27018);
    expect(defaultLocalPort('rabbitmq')).toBe(15443);
    expect(isSharedStore('mongo')).toBe(true);
    expect(isSharedStore('iam')).toBe(false);
  });
});
