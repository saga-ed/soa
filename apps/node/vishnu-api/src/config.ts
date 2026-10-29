export type Env = Record<string, string | undefined>;
export interface Config {
  environment: 'dev' | 'prod';
  origin: string;
  gateUrl: string;
  jwksUrl: string;
  port: number;
  permissions: string[];
  mqEnabled: boolean;
  /** Exact MQ telemetry deployment; null while MQ is off (d3). */
  mqDeployment: string | null;
  datadogScope: 'environment' | 'deployment';
  deployment: string;
  deploymentTag: string;
}

/** Hosted mode has no auth bypass and never inherits synthetic scope defaults. */
export function loadConfig(env: Env): Config {
  if (env.VISHNU_ENVIRONMENT !== 'dev' && env.VISHNU_ENVIRONMENT !== 'prod')
    throw new Error('VISHNU_ENVIRONMENT must be dev or prod');
  const environment = env.VISHNU_ENVIRONMENT;
  const domain = environment === 'prod' ? 'sagaops.org' : 'wootops.org';
  const origin = env.VISHNU_PUBLIC_ORIGIN ?? `https://vishnu.${domain}`;
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.protocol !== 'https:' || parsed.hostname !== `vishnu.${domain}`)
    throw new Error('VISHNU_PUBLIC_ORIGIN must match the environment staff domain');
  if (env.JANUS_REQUIRED === 'false') throw new Error('Hosted Vishnu requires JANUS');
  const gateUrl = `https://gate.${domain}`;
  const port = Number(env.PORT ?? '8931');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (env.VISHNU_DATADOG_SCOPE && !['environment', 'deployment'].includes(env.VISHNU_DATADOG_SCOPE)) throw new Error('Invalid Datadog scope level');
  const deployment = env.VISHNU_DATADOG_SCOPE === 'environment' ? 'all' : env.VISHNU_DATADOG_DEPLOYMENT;
  const deploymentTag = env.VISHNU_DATADOG_DEPLOYMENT_TAG ?? 'deployment.identifier';
  if (!deployment || !/^[a-zA-Z0-9_.:/-]+$/.test(deployment) || !/^[a-zA-Z0-9_.]+$/.test(deploymentTag))
    throw new Error('Explicit Datadog deployment scope required');
  if (env.VISHNU_DATADOG_ENV !== environment) throw new Error('Datadog environment must match hosted environment');
  if (env.VISHNU_MQ_ENABLED && !['true', 'false'].includes(env.VISHNU_MQ_ENABLED))
    throw new Error('Invalid VISHNU_MQ_ENABLED');
  const mqEnabled = env.VISHNU_MQ_ENABLED === 'true';
  const datadogScope = env.VISHNU_DATADOG_SCOPE === 'environment' ? 'environment' : 'deployment';
  // d3: environment-wide Datadog may pair with its own exact MQ scope; a
  // deployment-scoped Datadog view must still describe the same population.
  let mqDeployment: string | null = null;
  if (mqEnabled) {
    if (env.EVENT_STATS_ENVIRONMENT !== environment)
      throw new Error('MQ and Datadog must use the same environment');
    mqDeployment = env.EVENT_STATS_DEPLOYMENT ?? '';
    if (!/^[a-zA-Z0-9_.-]+$/.test(mqDeployment)) throw new Error('Explicit MQ deployment scope required');
    if (datadogScope === 'deployment' && mqDeployment !== deployment)
      throw new Error('MQ and deployment-scoped Datadog must use the same deployment');
  }
  return { environment, origin, gateUrl, jwksUrl: `${gateUrl}/.well-known/jwks.json`, port,
    permissions: ['iam-admin', 'staff:super_admin', 'staff:support', 'staff:org_admin'],
    mqEnabled, mqDeployment, datadogScope, deployment, deploymentTag };
}
