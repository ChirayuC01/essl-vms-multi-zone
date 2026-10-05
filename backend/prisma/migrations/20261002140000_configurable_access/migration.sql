-- Two-zone rebuild, Phase 2b: configurable access.
--
-- Roles become rows an Admin can add to; each role has a grid of
-- feature:action grants; any operator may carry ALLOW/DENY overrides.
--
-- What an upgraded site sees: nothing changes. Every former enum value becomes
-- a role row with the same key, every operator keeps their role, and each
-- role's grants are the exact Phase 2 permissions expressed as grid cells
-- (generated from the Phase 2 matrix; checked by services/access.test.ts).
-- ADMIN is a system role that always holds everything and has no rows here.

CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "role_key_key" ON "role"("key");
CREATE UNIQUE INDEX "role_name_ci_key" ON "role" (UPPER("name"));

CREATE TABLE "role_permission" (
    "role_id" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission")
);
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "OverrideEffect" AS ENUM ('ALLOW', 'DENY');

CREATE TABLE "user_permission_override" (
    "user_id" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" "OverrideEffect" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_override_pkey" PRIMARY KEY ("user_id","permission")
);
ALTER TABLE "user_permission_override" ADD CONSTRAINT "user_permission_override_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "role" ("id", "key", "name", "description", "is_system", "updated_at") VALUES
  ('role_admin', 'ADMIN', 'Administrator', 'Full access. A system role: always holds everything and cannot be edited.', true, CURRENT_TIMESTAMP),
  ('role_authorized_person', 'AUTHORIZED_PERSON', 'Authorized person', 'The 0.4.x operator role.', false, CURRENT_TIMESTAMP),
  ('role_security_incharge', 'SECURITY_INCHARGE', 'Security in-charge', 'Security plus blacklist and audit trail.', false, CURRENT_TIMESTAMP),
  ('role_security', 'SECURITY', 'Security', 'Runs the gate: passes, walk-ins, long-term passes, exit override.', false, CURRENT_TIMESTAMP),
  ('role_host', 'HOST', 'Host', 'Raises and decides their own visitors'' requests.', false, CURRENT_TIMESTAMP),
  ('role_hr', 'HR', 'HR', 'Read only until in-system duties are confirmed.', false, CURRENT_TIMESTAMP),
  ('role_hod', 'HOD', 'HOD', 'Read only until in-system duties are confirmed.', false, CURRENT_TIMESTAMP);

INSERT INTO "role_permission" ("role_id", "permission") VALUES
  ('role_authorized_person', 'commands:update'),
  ('role_authorized_person', 'commands:view'),
  ('role_authorized_person', 'dashboard:view'),
  ('role_authorized_person', 'device_refresh:update'),
  ('role_authorized_person', 'devices:view'),
  ('role_authorized_person', 'directory:create'),
  ('role_authorized_person', 'directory:update'),
  ('role_authorized_person', 'directory:view'),
  ('role_authorized_person', 'license:view'),
  ('role_authorized_person', 'maintenance:view'),
  ('role_authorized_person', 'onsite:view'),
  ('role_authorized_person', 'passes:create'),
  ('role_authorized_person', 'passes:delete'),
  ('role_authorized_person', 'passes:update'),
  ('role_authorized_person', 'passes:view'),
  ('role_authorized_person', 'people:create'),
  ('role_authorized_person', 'people:delete'),
  ('role_authorized_person', 'people:update'),
  ('role_authorized_person', 'people:view'),
  ('role_authorized_person', 'punches:view'),
  ('role_authorized_person', 'reports:view'),
  ('role_authorized_person', 'settings:view'),
  ('role_authorized_person', 'zones:view'),
  ('role_host', 'visit_requests:create'),
  ('role_host', 'visit_requests:update'),
  ('role_host', 'visit_requests:view'),
  ('role_host', 'zone_widen:update'),
  ('role_security', 'commands:update'),
  ('role_security', 'commands:view'),
  ('role_security', 'dashboard:view'),
  ('role_security', 'device_refresh:update'),
  ('role_security', 'devices:view'),
  ('role_security', 'directory:create'),
  ('role_security', 'directory:update'),
  ('role_security', 'directory:view'),
  ('role_security', 'exit_override:update'),
  ('role_security', 'license:view'),
  ('role_security', 'longterm_passes:create'),
  ('role_security', 'maintenance:view'),
  ('role_security', 'onsite:view'),
  ('role_security', 'passes:create'),
  ('role_security', 'passes:delete'),
  ('role_security', 'passes:update'),
  ('role_security', 'passes:view'),
  ('role_security', 'people:create'),
  ('role_security', 'people:delete'),
  ('role_security', 'people:update'),
  ('role_security', 'people:view'),
  ('role_security', 'punches:view'),
  ('role_security', 'reports:view'),
  ('role_security', 'settings:view'),
  ('role_security', 'walkins:create'),
  ('role_security', 'zones:view'),
  ('role_security_incharge', 'audit:view'),
  ('role_security_incharge', 'blacklist:update'),
  ('role_security_incharge', 'commands:update'),
  ('role_security_incharge', 'commands:view'),
  ('role_security_incharge', 'dashboard:view'),
  ('role_security_incharge', 'device_refresh:update'),
  ('role_security_incharge', 'devices:view'),
  ('role_security_incharge', 'directory:create'),
  ('role_security_incharge', 'directory:update'),
  ('role_security_incharge', 'directory:view'),
  ('role_security_incharge', 'exit_override:update'),
  ('role_security_incharge', 'license:view'),
  ('role_security_incharge', 'longterm_passes:create'),
  ('role_security_incharge', 'maintenance:view'),
  ('role_security_incharge', 'onsite:view'),
  ('role_security_incharge', 'passes:create'),
  ('role_security_incharge', 'passes:delete'),
  ('role_security_incharge', 'passes:update'),
  ('role_security_incharge', 'passes:view'),
  ('role_security_incharge', 'people:create'),
  ('role_security_incharge', 'people:delete'),
  ('role_security_incharge', 'people:update'),
  ('role_security_incharge', 'people:view'),
  ('role_security_incharge', 'punches:view'),
  ('role_security_incharge', 'reports:view'),
  ('role_security_incharge', 'settings:view'),
  ('role_security_incharge', 'walkins:create'),
  ('role_security_incharge', 'zones:view'),
  ('role_hr', 'commands:view'),
  ('role_hr', 'dashboard:view'),
  ('role_hr', 'devices:view'),
  ('role_hr', 'directory:view'),
  ('role_hr', 'license:view'),
  ('role_hr', 'maintenance:view'),
  ('role_hr', 'onsite:view'),
  ('role_hr', 'passes:view'),
  ('role_hr', 'people:view'),
  ('role_hr', 'punches:view'),
  ('role_hr', 'reports:view'),
  ('role_hr', 'settings:view'),
  ('role_hr', 'zones:view'),
  ('role_hod', 'commands:view'),
  ('role_hod', 'dashboard:view'),
  ('role_hod', 'devices:view'),
  ('role_hod', 'directory:view'),
  ('role_hod', 'license:view'),
  ('role_hod', 'maintenance:view'),
  ('role_hod', 'onsite:view'),
  ('role_hod', 'passes:view'),
  ('role_hod', 'people:view'),
  ('role_hod', 'punches:view'),
  ('role_hod', 'reports:view'),
  ('role_hod', 'settings:view'),
  ('role_hod', 'zones:view');


-- Operators now point at a role by its immutable key.
ALTER TABLE "app_user" ADD COLUMN "role_key" TEXT;
UPDATE "app_user" SET "role_key" = "role"::text;
ALTER TABLE "app_user" ALTER COLUMN "role_key" SET NOT NULL;
ALTER TABLE "app_user" DROP COLUMN "role";
DROP TYPE "UserRole";
CREATE INDEX "app_user_role_key_idx" ON "app_user"("role_key");
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_role_key_fkey"
  FOREIGN KEY ("role_key") REFERENCES "role"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
