#!/usr/bin/env node
// One loopback-only OTLP receiver per developer machine. Never writes API keys.
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';

const action = process.argv[2] ?? 'status';
const name = 'saga-synthetic-datadog';
const run = args => {
  const result = spawnSync('docker', args, { env: process.env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (action === 'status') {
  run(['exec', name, 'agent', 'status']);
} else if (action === 'start') {
  if (!process.env.DD_API_KEY) throw new Error('Provide DD_API_KEY in the environment; do not put it in command arguments.');
  const machine = process.env.SS_TELEMETRY_MACHINE ?? hostname().toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(machine)) throw new Error('Invalid SS_TELEMETRY_MACHINE');
  const existing = spawnSync('docker', ['container', 'inspect', '--format', '{{.State.Running}}', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (existing.status === 0) {
    if (existing.stdout.trim() !== 'true') run(['start', name]);
    console.log(`${name} exists; retained its original configuration. Use status to inspect it.`);
    process.exit(0);
  }
  run(['run', '-d', '--name', name, '--label', 'saga.synthetic.telemetry=true',
    '--restart', 'unless-stopped', '-p', '127.0.0.1:4318:4318',
    '-e', 'DD_API_KEY', '-e', `DD_SITE=${process.env.DD_SITE ?? 'datadoghq.com'}`,
    '-e', `DD_HOSTNAME=synthetic-${machine}`, '-e', `DD_TAGS=synthetic.machine:${machine}`,
    '-e', 'DD_APM_ENABLED=true', '-e', 'DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318',
    '-e', 'DD_OTLP_CONFIG_METRICS_RESOURCE_ATTRIBUTES_AS_TAGS=true',
    '-e', 'DD_LOGS_ENABLED=false', '-e', 'DD_PROCESS_AGENT_ENABLED=false',
    '-e', 'DD_APM_NON_LOCAL_TRAFFIC=true',
    process.env.SS_DATADOG_AGENT_IMAGE ?? 'gcr.io/datadoghq/agent:7.84.0@sha256:5e09e2852cc2b07f5d04ba60007470619e0910f9c6d0bc475158fc819e46543c']);
} else {
  throw new Error('Usage: node scripts/datadog-agent.mjs start|status');
}
