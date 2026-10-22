# I#537 — observed participant inventory

Captured from slot 3 reports and broker bindings on 2026-10-22. Scope: synthetic / slot-3 / soa-s3 / vhost `/`.

| Service | Role | Exchange | Queue / consumer | Event types |
| --- | --- | --- | --- | --- |
| programs-api | consumer | iam.events | programs-api.iam-membership-store | iam.group_membership.added, iam.group_membership.removed |
| programs-api | consumer | iam.events | programs-api.iam-projection | iam.user.created, iam.user.updated |
| programs-api | consumer | iam.events | programs-api.membership-projection | iam.group_membership.added, iam.group_membership.removed |
| programs-api | consumer | programs.events | programs-api.enrollment-reconcile | programs.period_assignment.changed |
| programs-api | consumer | programs.events | programs-api.pod-group-reconcile | programs.pod.created, programs.pod.deleted, programs.pod_membership.added, programs.pod_membership.bulk_changed, programs.pod_membership.removed, programs.pod_tutor.added, programs.pod_tutor.removed |
| programs-api | consumer | programs.events | programs-api.program-group-reconcile | programs.program.created, programs.program.deleted, programs.program.updated |
| programs-api | consumer | scheduling.events | programs-api.slot-projection | scheduling.slot.created, scheduling.slot.deactivated, scheduling.slot.updated |
| programs-api | consumer | sess.events | programs-api.adhoc-pod-assignment | sess.session.ad_hoc_created |
| programs-api | producer | programs.events | — | programs.program.created |
| iam-api | producer | iam.events | — | iam.group.created |
| scheduling-api | consumer | programs.events | scheduling-api.programs-projection | programs.period.created, programs.period.deleted, programs.period.updated, programs.period_rotation_config.changed, programs.program.created, programs.program.deleted, programs.program.updated |

Producer/outbox: attempts, transport acceptance and failures; confirmed publish unsupported. Consumer: delivery, redelivery, transaction commits, duplicate skips, processing failure categories, ack/nack attempts and failures. The stats capability list preserves idle service roles.

Package candidates: stats 0.1.0, consumer 0.2.0, outbox 0.3.0. Registry publication is pending; local overlays select exactly these three packages.

## Broker binding audit

| Source exchange | Destination | Routing key |
| --- | --- | --- |
| iam.events | authz-api.iam-projection | `iam.group.*` |
| iam.events | authz-api.iam-projection | `iam.group_membership.*` |
| iam.events | authz-api.iam-projection | `iam.persona_assignment.*` |
| iam.events | authz-api.iam-projection | `iam.persona_definition.*` |
| iam.events | authz-api.iam-projection | `iam.persona_policies.*` |
| iam.events | authz-api.iam-projection | `iam.user.*` |
| iam.events | programs-api.iam-membership-store | `iam.group_membership.*` |
| iam.events | programs-api.iam-projection | `iam.user.*` |
| iam.events | programs-api.membership-projection | `iam.group_membership.*` |
| iam.events | sessions-api.iam-user-projection | `iam.user.*` |
| iam.events | vishnu.slot-3.event-stats.v1 | `observability.event_stats.reported` |
| programs.events | programs-api.enrollment-reconcile | `programs.period_assignment.changed` |
| programs.events | programs-api.pod-group-reconcile | `programs.pod.created` |
| programs.events | programs-api.pod-group-reconcile | `programs.pod.deleted` |
| programs.events | programs-api.pod-group-reconcile | `programs.pod_membership.added` |
| programs.events | programs-api.pod-group-reconcile | `programs.pod_membership.bulk_changed` |
| programs.events | programs-api.pod-group-reconcile | `programs.pod_membership.removed` |
| programs.events | programs-api.pod-group-reconcile | `programs.pod_tutor.added` |
| programs.events | programs-api.pod-group-reconcile | `programs.pod_tutor.removed` |
| programs.events | programs-api.program-group-reconcile | `programs.program.created` |
| programs.events | programs-api.program-group-reconcile | `programs.program.deleted` |
| programs.events | programs-api.program-group-reconcile | `programs.program.updated` |
| programs.events | scheduling-api.programs-projection | `programs.period.*` |
| programs.events | scheduling-api.programs-projection | `programs.period_rotation_config.*` |
| programs.events | scheduling-api.programs-projection | `programs.program.*` |
| programs.events | sessions-api.programs-projection | `programs.cohort.*` |
| programs.events | sessions-api.programs-projection | `programs.cohort_membership.*` |
| programs.events | sessions-api.programs-projection | `programs.period.*` |
| programs.events | sessions-api.programs-projection | `programs.period_membership.*` |
| programs.events | sessions-api.programs-projection | `programs.pod.*` |
| programs.events | sessions-api.programs-projection | `programs.pod_assignment.*` |
| programs.events | sessions-api.programs-projection | `programs.pod_assignment_override.*` |
| programs.events | sessions-api.programs-projection | `programs.pod_membership.*` |
| programs.events | sessions-api.programs-projection | `programs.pod_tutor.*` |
| programs.events | sessions-api.programs-projection | `programs.program.*` |
| programs.events | sessions-api.programs-projection | `programs.program_school_mapping.*` |
| programs.events | vishnu.slot-3.event-stats.v1 | `observability.event_stats.reported` |
| scheduling.events | programs-api.slot-projection | `scheduling.slot.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.holiday.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.manual_addition.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.occurrence_cancellation.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.occurrence_time_override.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.period_meeting.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.recurrence_rule.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.schedule.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.slot.*` |
| scheduling.events | sessions-api.scheduling-projection | `scheduling.slot_occurrence_cancellation.*` |
| scheduling.events | vishnu.slot-3.event-stats.v1 | `observability.event_stats.reported` |

No observed business binding matches `observability.event_stats.reported`; only Vishnu owns that exact binding. This is a selected-slot audit, not fleet-wide evidence.

Direct source search found one OutboxRelay per selected service, eight EventConsumers in programs and one in scheduling, all wrapped; no other direct publish call in their runtime src trees. Ad hoc repair/scripts and other services are outside this adoption slice.
