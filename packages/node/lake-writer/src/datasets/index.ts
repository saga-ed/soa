// Registry of every shared external-source dataset descriptor this
// package ships. See ./rostering.ts and ./programhub.ts for the
// per-dataset column contracts (mirrored from
// student-data-system/claude/projects/ledger-prod-lake/phase-4/dataset-catalog.md)
// and the package README's "Shared dataset descriptors" section for how
// a consuming exporter uses these.

import {
  districtSyncConfigRosteringDataset,
  iamGroupMembershipRosteringDataset,
  iamGroupRosteringDataset,
  identityCrosswalkRosteringDataset,
} from './rostering.js';
import {
  podMembershipProgramhubDataset,
  programPeriodProgramhubDataset,
  programPodProgramhubDataset,
  programProgramhubDataset,
  programSchoolMappingProgramhubDataset,
  sessionOccurrenceProgramhubDataset,
  sessionParticipantProgramhubDataset,
} from './programhub.js';

export * from './rostering.js';
export * from './programhub.js';

/** Every `rostering`-source dataset, keyed by registry key (`${dataset}_${sourceSystem}`). */
export const rosteringDatasets = {
  iam_group_rostering: iamGroupRosteringDataset,
  iam_group_membership_rostering: iamGroupMembershipRosteringDataset,
  identity_crosswalk_rostering: identityCrosswalkRosteringDataset,
  district_sync_config_rostering: districtSyncConfigRosteringDataset,
} as const;

/** Every `programhub`-source dataset, keyed by registry key (`${dataset}_${sourceSystem}`). */
export const programhubDatasets = {
  program_programhub: programProgramhubDataset,
  program_school_mapping_programhub: programSchoolMappingProgramhubDataset,
  program_period_programhub: programPeriodProgramhubDataset,
  program_pod_programhub: programPodProgramhubDataset,
  pod_membership_programhub: podMembershipProgramhubDataset,
  session_occurrence_programhub: sessionOccurrenceProgramhubDataset,
  session_participant_programhub: sessionParticipantProgramhubDataset,
} as const;

/** Every shared external-source dataset descriptor this package ships, keyed by registry key. */
export const externalDatasets = {
  ...rosteringDatasets,
  ...programhubDatasets,
} as const;
