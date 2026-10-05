import type { Prisma } from "@prisma/client";

// Central list of audit actions so reports can enumerate them; write rows
// through this helper (or inside a caller's transaction) so shapes stay
// uniform. actor null = system/device-initiated, or pre-auth operator
// actions until the login layer lands (Phase 1 M5 / Phase 4).

export const AuditAction = {
  PERSON_CREATED: "PERSON_CREATED",
  PERSON_UPDATED: "PERSON_UPDATED",
  PERSON_DEACTIVATED: "PERSON_DEACTIVATED",
  EMPLOYEE_RESIGNED: "EMPLOYEE_RESIGNED",
  EMPLOYEE_REHIRED: "EMPLOYEE_REHIRED",
  PHOTO_UPDATED: "PHOTO_UPDATED",
  // Authorization lifecycle. The *_REQUESTED actions record the operator's
  // decision; the plain past-tense ones record the device confirming it.
  // Both matter: the gap between them is where a device problem lives.
  ENTRY_PROVISION_REQUESTED: "ENTRY_PROVISION_REQUESTED",
  ENTRY_PROVISIONED: "ENTRY_PROVISIONED",
  ENTRY_BLOCK_REQUESTED: "ENTRY_BLOCK_REQUESTED",
  ENTRY_BLOCKED: "ENTRY_BLOCKED",
  ENTRY_UNBLOCK_REQUESTED: "ENTRY_UNBLOCK_REQUESTED",
  ENTRY_UNBLOCKED: "ENTRY_UNBLOCKED",
  ENTRY_DEPROVISION_REQUESTED: "ENTRY_DEPROVISION_REQUESTED",
  ENTRY_DEPROVISIONED: "ENTRY_DEPROVISIONED",
  // A punch whose status code contradicts its gate's role. Exceptional by
  // definition, so it is audited; ordinary movements are not — punch_event is
  // already the movement record and duplicating it here would bury this.
  PUNCH_DIRECTION_CONFLICT: "PUNCH_DIRECTION_CONFLICT",
  // Reconciliation. DRIFT_FOUND is what we saw and would not act on alone;
  // HEALED is what was corrected. Kept separate because the first is an
  // operator's problem and the second is a record of the system fixing
  // itself — conflating them would bury the ones that need a person.
  RECONCILE_DRIFT_FOUND: "RECONCILE_DRIFT_FOUND",
  RECONCILE_HEALED: "RECONCILE_HEALED",
  // An operator attempted something their role does not allow. Audited
  // because "who tried to do what they were not permitted to" is precisely
  // what this log exists to answer, and it is the only signal that separates
  // a misconfigured role from someone probing.
  PERMISSION_DENIED: "PERMISSION_DENIED",
  // Operator lifecycle. Passwords are never recorded in any form — only that
  // a change happened, by whom, and to which account.
  OPERATOR_CREATED: "OPERATOR_CREATED",
  OPERATOR_UPDATED: "OPERATOR_UPDATED",
  OPERATOR_PASSWORD_RESET: "OPERATOR_PASSWORD_RESET",
  OPERATOR_PASSWORD_CHANGED: "OPERATOR_PASSWORD_CHANGED",
  COMMAND_RETRIED: "COMMAND_RETRIED",
  DEVICE_QUERY_REQUESTED: "DEVICE_QUERY_REQUESTED",
  // Phase 6 first-run wizard: the one-time bootstrap of the very first
  // ADMIN, and adopting a device serial seen on the wire into the roster.
  SETUP_ADMIN_CREATED: "SETUP_ADMIN_CREATED",
  DEVICE_REGISTERED: "DEVICE_REGISTERED",
  // Phase 6 licensing: installing or replacing the license key. Warn-only —
  // nothing is ever blocked by license state, so there is no lockout/unlock
  // pair to record here, just the one act of installing a key.
  LICENSE_INSTALLED: "LICENSE_INSTALLED",
  // Adopting a device that was already populated before the VMS existed. The
  // scan commits the command queue for a long time, so who started one over
  // which range is a thing to be able to answer afterwards.
  DEVICE_SCAN_STARTED: "DEVICE_SCAN_STARTED",
  // Site topology (two-zone rebuild). Moving a terminal between zones changes
  // who it admits, so it is recorded with before/after like any access change.
  ZONE_CREATED: "ZONE_CREATED",
  ZONE_UPDATED: "ZONE_UPDATED",
  DEVICE_ZONE_CHANGED: "DEVICE_ZONE_CHANGED",
  // Site settings: detail carries each changed key with its old and new value.
  SETTINGS_CHANGED: "SETTINGS_CHANGED",
  // Configurable access (Phase 2b). Grid changes record cells added/removed;
  // user overrides record each cell's before/after effect.
  ROLE_CREATED: "ROLE_CREATED",
  ROLE_UPDATED: "ROLE_UPDATED",
  ROLE_PERMISSIONS_CHANGED: "ROLE_PERMISSIONS_CHANGED",
  USER_PERMISSIONS_CHANGED: "USER_PERMISSIONS_CHANGED",
  // Phase 3. Document rows are recorded against the PERSON, so they appear in
  // that person's history alongside everything else that happened to them.
  PASS_TYPE_CREATED: "PASS_TYPE_CREATED",
  PASS_TYPE_UPDATED: "PASS_TYPE_UPDATED",
  DOCUMENT_UPLOADED: "DOCUMENT_UPLOADED",
  DOCUMENT_DOWNLOADED: "DOCUMENT_DOWNLOADED",
  DOCUMENT_REMOVED: "DOCUMENT_REMOVED",
} as const;
export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

export function auditRow(opts: {
  action: AuditActionName;
  entityType: string;
  entityId: string;
  detail?: Prisma.InputJsonValue;
  /** Omitted / null / undefined all mean system- or device-initiated. */
  actorId?: string | null | undefined;
}): Prisma.AuditLogCreateInput {
  const row: Prisma.AuditLogCreateInput = {
    action: opts.action,
    entityType: opts.entityType,
    entityId: opts.entityId,
  };
  if (opts.detail !== undefined) row.detail = opts.detail;
  if (opts.actorId) row.actor = { connect: { id: opts.actorId } };
  return row;
}
