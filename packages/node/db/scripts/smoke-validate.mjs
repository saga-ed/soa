#!/usr/bin/env node
// Validate @saga-ed/soa-db MongoProvider against three real systems via
// SSM port-forwards (set up by the operator before running this script):
//
//   localhost:27117 → db-host:27017  (dev-shared-mongo, no TLS, no auth, replSet=wootmath)
//   localhost:27120 → db-host:27020  (dev-auth-mongo,  TLS + SCRAM,    replSet=devauth)
//   localhost:27317 → staging-mongo:27017 (TLS + SCRAM, replSet=saga-rs)
//
// Both staging and dev-auth-mongo cert SANs include `localhost` so TLS
// hostname validation succeeds when connecting through localhost
// tunnels.

import { MongoProvider } from '../dist/index.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const ssm = new SSMClient({ region: 'us-west-2' });
const sm = new SecretsManagerClient({ region: 'us-west-2' });

async function readSecret(arnOrName) {
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arnOrName }));
  return JSON.parse(out.SecretString);
}

async function readSsm(name) {
  const out = await ssm.send(new GetParameterCommand({ Name: name }));
  return out.Parameter.Value;
}

async function smoke(label, config) {
  const banner = `\n========== ${label} ==========`;
  console.log(banner);
  console.log('hosts:', config.hosts, 'tls:', !!config.tls, 'rs:', config.replicaSet ?? '(none, dropped for tunnel)', 'authSource:', config.authSource ?? '(none)');
  // directConnection bypasses RS topology discovery — required when reaching
  // the seed via an SSM tunnel, since the RS members advertise their internal
  // VPC addresses which aren't reachable through the tunnel. directConnection
  // conflicts with the URI's replicaSet param, so drop replicaSet here for
  // smoke purposes — production callers keep it.
  const { replicaSet: _drop, ...rest } = config;
  const provider = new MongoProvider({
    ...rest,
    options: { ...(rest.options ?? {}), directConnection: true },
  });
  await provider.connect();
  const client = provider.getClient();
  const db = client.db(config.database);
  const coll = db.collection('soa_smoke');
  const doc = { run: label, ts: new Date(), nonce: Math.random().toString(36).slice(2) };
  const ins = await coll.insertOne(doc);
  const found = await coll.findOne({ _id: ins.insertedId });
  if (!found || found.nonce !== doc.nonce) throw new Error(`round-trip mismatch in ${label}`);
  await coll.deleteOne({ _id: ins.insertedId });
  console.log('OK — insert+find+delete round-trip succeeded');
  await provider.disconnect();
}

async function main() {
  // Test 1: dev-shared-mongo (no TLS, no auth)
  await smoke('dev-shared-mongo (no TLS, no auth)', {
    configType: 'MONGO',
    instanceName: 'dev-shared',
    hosts: ['localhost:27117'],
    database: 'soa_db_smoke',
    replicaSet: 'wootmath',
  });

  // Test 2: dev-auth-mongo (TLS + SCRAM)
  const devAuthCaArn = await readSsm('/dev/db-host/dev-auth-mongo/ca-secret-arn');
  const devAuthCa = (await readSecret(devAuthCaArn)).ca_cert;
  const devAuthLedger = await readSecret('/dev/db-host/dev-auth-mongo/ledger-api-password');
  await smoke('dev-auth-mongo (TLS + SCRAM, ledger_api_app)', {
    configType: 'MONGO',
    instanceName: 'dev-auth',
    hosts: ['localhost:27120'],
    database: 'ledger_api_db',
    username: devAuthLedger.username,
    password: devAuthLedger.password,
    replicaSet: 'devauth',
    authSource: 'ledger_api_db',
    tls: true,
    tlsCAContent: devAuthCa,
  });

  // Test 3: staging mongo (TLS + SCRAM, master admin since per-service users not yet provisioned)
  const stagingCaArn = await readSsm('/shared/infra/staging/mongodb-ca-secret-arn');
  const stagingMasterArn = await readSsm('/shared/infra/staging/mongodb-master-secret-arn');
  const stagingRsName = await readSsm('/shared/infra/staging/mongodb-replica-set-name');
  const stagingCa = (await readSecret(stagingCaArn)).ca_cert;
  const stagingMaster = await readSecret(stagingMasterArn);
  await smoke('staging mongo (TLS + SCRAM, master admin)', {
    configType: 'MONGO',
    instanceName: 'staging',
    hosts: ['localhost:27317'],
    database: 'soa_db_smoke',
    username: stagingMaster.username,
    password: stagingMaster.password,
    replicaSet: stagingRsName,
    authSource: 'admin',
    tls: true,
    tlsCAContent: stagingCa,
  });

  console.log('\nAll three round-trips OK.');
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  if (e.cause) console.error('cause:', e.cause);
  process.exit(1);
});
