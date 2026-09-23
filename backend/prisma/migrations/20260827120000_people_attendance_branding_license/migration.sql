-- This release renames the active identity domain from Vendor to Person.
-- PostgreSQL table/column renames preserve foreign keys for anyone who chooses
-- an in-place upgrade, while the supported rollout remains a clean install.

CREATE TYPE "PersonCategory" AS ENUM ('EMPLOYEE', 'VISITOR');
CREATE TYPE "AttendanceQuality" AS ENUM ('EXACT', 'LEGACY_COUNTS_ONLY');
CREATE TYPE "PunchDirection" AS ENUM ('IN', 'OUT');

ALTER TABLE "vendor" RENAME TO "person";
ALTER TABLE "vendor_biometric" RENAME TO "person_biometric";
ALTER TABLE "person_biometric" RENAME COLUMN "vendor_id" TO "person_id";
ALTER TABLE "entry" RENAME COLUMN "vendor_id" TO "person_id";
ALTER TABLE "sync_command" RENAME COLUMN "vendor_id" TO "person_id";
ALTER TABLE "punch_day_summary" RENAME COLUMN "vendor_id" TO "person_id";
ALTER TABLE "admission_queue" RENAME COLUMN "vendor_id" TO "person_id";

ALTER TABLE "person" RENAME CONSTRAINT "vendor_pkey" TO "person_pkey";
ALTER TABLE "person_biometric" RENAME CONSTRAINT "vendor_biometric_pkey" TO "person_biometric_pkey";
ALTER TABLE "person_biometric" RENAME CONSTRAINT "vendor_biometric_vendor_id_fkey" TO "person_biometric_person_id_fkey";
ALTER TABLE "entry" RENAME CONSTRAINT "entry_vendor_id_fkey" TO "entry_person_id_fkey";
ALTER TABLE "sync_command" RENAME CONSTRAINT "sync_command_vendor_id_fkey" TO "sync_command_person_id_fkey";
ALTER INDEX "vendor_biometric_vendor_id_key" RENAME TO "person_biometric_person_id_key";
ALTER INDEX "entry_vendor_id_idx" RENAME TO "entry_person_id_idx";
ALTER INDEX "vendor_aadhar_number_key" RENAME TO "person_aadhar_number_key";
ALTER INDEX "vendor_essl_user_id_upper_key" RENAME TO "person_essl_user_id_upper_key";

CREATE TABLE "company" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "department" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "company_name_ci_key" ON "company" (UPPER("name"));
CREATE UNIQUE INDEX "department_name_ci_key" ON "department" (UPPER("name"));

ALTER TABLE "person"
  ADD COLUMN "category" "PersonCategory" NOT NULL DEFAULT 'VISITOR',
  ADD COLUMN "company_id" TEXT,
  ADD COLUMN "department_id" TEXT,
  ADD COLUMN "pan_number" TEXT;

ALTER TABLE "person" DROP COLUMN "company";
ALTER TABLE "person" ADD CONSTRAINT "person_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "person" ADD CONSTRAINT "person_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "person_category_idx" ON "person"("category");
CREATE INDEX "person_company_id_idx" ON "person"("company_id");
CREATE INDEX "person_department_id_idx" ON "person"("department_id");
CREATE UNIQUE INDEX "person_pan_number_key" ON "person"("pan_number");
CREATE UNIQUE INDEX "person_pan_number_ci_key" ON "person"(UPPER("pan_number"));
ALTER TABLE "device" RENAME COLUMN "vendor_id_patterns" TO "visitor_id_patterns";
ALTER TABLE "device" ADD COLUMN "employee_id_patterns" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
-- Empty formerly meant "all". It now safely means "unclassified".
UPDATE "device" SET "visitor_id_patterns" = ARRAY[]::TEXT[] WHERE "visitor_id_patterns" = ARRAY[]::TEXT[];

CREATE TABLE "employee_device_access" (
  "id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "desired_access" BOOLEAN NOT NULL DEFAULT true,
  "provisioned" BOOLEAN NOT NULL DEFAULT false,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assigned_by" TEXT,
  "removed_at" TIMESTAMP(3),
  "removed_by" TEXT,
  "removal_reason" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "employee_device_access_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "employee_device_access_person_id_device_id_key"
  ON "employee_device_access"("person_id", "device_id");
CREATE INDEX "employee_device_access_device_id_desired_access_idx"
  ON "employee_device_access"("device_id", "desired_access");
ALTER TABLE "employee_device_access" ADD CONSTRAINT "employee_device_access_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_device_access" ADD CONSTRAINT "employee_device_access_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_device_access" ADD CONSTRAINT "employee_device_access_assigned_by_fkey"
  FOREIGN KEY ("assigned_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "employee_device_access" ADD CONSTRAINT "employee_device_access_removed_by_fkey"
  FOREIGN KEY ("removed_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE "punch_day_summary";
CREATE TABLE "attendance_day_summary" (
  "id" TEXT NOT NULL,
  "essl_user_id" TEXT NOT NULL,
  "person_id" TEXT,
  "local_date" TEXT NOT NULL,
  "device_ids" TEXT[] NOT NULL,
  "device_punch_counts" JSONB NOT NULL DEFAULT '{}',
  "first_in_utc" TIMESTAMP(3),
  "last_out_utc" TIMESTAMP(3),
  "worked_seconds" INTEGER NOT NULL DEFAULT 0,
  "punch_count" INTEGER NOT NULL,
  "in_count" INTEGER NOT NULL,
  "out_count" INTEGER NOT NULL,
  "unmatched_in" INTEGER NOT NULL DEFAULT 0,
  "unmatched_out" INTEGER NOT NULL DEFAULT 0,
  "quality" "AttendanceQuality" NOT NULL DEFAULT 'EXACT',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attendance_day_summary_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "attendance_day_summary_essl_user_id_local_date_key"
  ON "attendance_day_summary"("essl_user_id", "local_date");
CREATE INDEX "attendance_day_summary_local_date_idx" ON "attendance_day_summary"("local_date");
CREATE INDEX "attendance_day_summary_person_id_idx" ON "attendance_day_summary"("person_id");
ALTER TABLE "attendance_day_summary" ADD CONSTRAINT "attendance_day_summary_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "license" ADD COLUMN "license_id" TEXT;
ALTER TABLE "punch_event" ADD COLUMN "direction" "PunchDirection";
