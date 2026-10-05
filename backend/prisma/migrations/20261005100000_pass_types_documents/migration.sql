-- Two-zone rebuild, Phase 3: pass types, visitor profile fields, documents.
--
-- What an upgraded site sees: no pass types yet (an Admin creates the site's
-- own), every existing person keeps their data, and "details complete" is
-- backfilled with exactly the rule the console already enforced (mobile,
-- company, department, and Aadhaar or PAN). New access cells are granted to
-- the roles that already handle people, so nobody loses a screen.

CREATE TYPE "PassKind" AS ENUM ('SHORT_TERM', 'LONG_TERM');

CREATE TABLE "pass_type" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "PassKind" NOT NULL DEFAULT 'SHORT_TERM',
    "entry_modes" "EntryMode"[] DEFAULT ARRAY['SINGLE_ENTRY', 'MULTI_ENTRY']::"EntryMode"[],
    "requires_host_clear" BOOLEAN NOT NULL DEFAULT true,
    "max_validity_days" INTEGER,
    "field_rules" JSONB NOT NULL DEFAULT '{}',
    "credential_label" TEXT,
    "credential_caps_validity" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pass_type_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pass_type_name_ci_key" ON "pass_type" (UPPER("name"));

ALTER TABLE "person"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "designation" TEXT,
  ADD COLUMN "govt_id_type" TEXT,
  ADD COLUMN "govt_id_number" TEXT,
  ADD COLUMN "vehicle_number" TEXT,
  ADD COLUMN "police_clearance" BOOLEAN,
  ADD COLUMN "credential_number" TEXT,
  ADD COLUMN "credential_expires_at" TIMESTAMP(3),
  ADD COLUMN "pass_type_id" TEXT,
  ADD COLUMN "details_complete" BOOLEAN NOT NULL DEFAULT false;

UPDATE "person" SET "details_complete" =
  "mobile" IS NOT NULL AND "company_id" IS NOT NULL AND "department_id" IS NOT NULL
  AND ("aadhar_number" IS NOT NULL OR "pan_number" IS NOT NULL);

CREATE INDEX "person_pass_type_id_idx" ON "person"("pass_type_id");
CREATE INDEX "person_details_complete_idx" ON "person"("details_complete");
ALTER TABLE "person" ADD CONSTRAINT "person_pass_type_id_fkey"
  FOREIGN KEY ("pass_type_id") REFERENCES "pass_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "person_document" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "stored_path" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CONSOLE',
    "uploaded_by" TEXT,
    "removed_at" TIMESTAMP(3),
    "removed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_document_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "person_document_person_id_idx" ON "person_document"("person_id");
ALTER TABLE "person_document" ADD CONSTRAINT "person_document_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Access cells for the new features, given to the roles that already hold
-- the matching people cell. Pass type editing stays with Administrators.
INSERT INTO "role_permission" ("role_id", "permission")
SELECT "role_id", 'documents:view' FROM "role_permission" WHERE "permission" = 'people:view'
UNION SELECT "role_id", 'documents:create' FROM "role_permission" WHERE "permission" = 'people:update'
UNION SELECT "role_id", 'documents:delete' FROM "role_permission" WHERE "permission" = 'people:delete'
UNION SELECT "role_id", 'pass_types:view' FROM "role_permission" WHERE "permission" = 'people:view'
ON CONFLICT DO NOTHING;
