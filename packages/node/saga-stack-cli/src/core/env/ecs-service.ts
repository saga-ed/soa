/** One ACTIVE row from `ecs describe-services` (see `ECS_SERVICE_ROW_QUERY`). */
export interface EcsServiceRow {
  serviceName: string;
  runningCount: number;
  desiredCount: number;
  taskDefinition: string;
}

/** `--query` yielding `[[name, status, running, desired, taskDef], …]` for ACTIVE services only. */
export const ECS_SERVICE_ROW_QUERY =
  "services[?status=='ACTIVE'].[serviceName,status,runningCount,desiredCount,taskDefinition]";

/** Candidate service names for a store, in preference order (prod runs blue/green pairs). */
export const serviceCandidates = (base: string, ledgerIdentifier: string): string[] => [
  `${base}-${ledgerIdentifier}`,
  `${base}-blue`,
  `${base}-green`,
];

export const parseServiceRows = (raw: unknown): EcsServiceRow[] =>
  ((raw as unknown[][] | null) ?? []).map((r) => ({
    serviceName: String(r[0]),
    runningCount: Number(r[2]),
    desiredCount: Number(r[3]),
    taskDefinition: String(r[4]),
  }));

/**
 * Pick among ACTIVE rows: running beats not-running, then candidate order.
 * `multipleRunning` flags a blue/green overlap the caller should surface.
 */
export function pickService(
  rows: EcsServiceRow[],
  candidates: string[],
): { row: EcsServiceRow; reason: string; multipleRunning: boolean } | undefined {
  const ordered = candidates.flatMap((c) => rows.filter((r) => r.serviceName === c));
  const running = ordered.filter((r) => r.runningCount > 0);
  if (running.length > 0) {
    return {
      row: running[0]!,
      reason: running.length > 1 ? `first running in preference order (${running.map((r) => r.serviceName).join(', ')} all live)` : 'only running service',
      multipleRunning: running.length > 1,
    };
  }
  const first = ordered[0];
  return first === undefined ? undefined : { row: first, reason: 'none running — first ACTIVE in preference order', multipleRunning: false };
}
