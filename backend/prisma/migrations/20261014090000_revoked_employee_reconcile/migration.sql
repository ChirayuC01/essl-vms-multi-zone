-- F3 B1/B2 (ported from 0.4.20).

-- Reconciliation rotates through (person, terminal) pairs by when each was
-- last asked about; this keeps that lookup an index probe per pair. IF NOT
-- EXISTS: a database that ran 0.4.20+ already has it.
CREATE INDEX IF NOT EXISTS "sync_command_person_id_target_device_id_type_created_at_idx"
  ON "sync_command"("person_id", "target_device_id", "type", "created_at");

-- Repair rows 0.4.19 could leave behind: a terminal USER record for a
-- resigned Employee re-adopted them with desired access. Removed now (not at
-- resignation) so the reconciliation window restarts for them.
UPDATE "employee_device_access" a
   SET "desired_access" = false,
       "removed_at" = (NOW() AT TIME ZONE 'UTC'),
       "removal_reason" = COALESCE(a."removal_reason", 'Employee resigned'),
       "updated_at" = (NOW() AT TIME ZONE 'UTC')
  FROM "person" p
 WHERE p."id" = a."person_id"
   AND p."resigned_at" IS NOT NULL
   AND a."desired_access" = true;
