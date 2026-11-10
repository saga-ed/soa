export {
    assertLaneSafe,
    checkLaneSafety,
    resolveLane,
    LaneGuardError,
    DEV_ACCOUNT_ID,
    DEFAULT_PROD_PUBLIC_APEXES,
    DEFAULT_ALLOWED_HOST_SUFFIXES,
    DEFAULT_NON_EGRESS_VAR_PATTERNS,
} from './lane-guard.js';
export type { Lane, LaneGuardOptions, LaneResolution, LaneViolation } from './lane-guard.js';
