-- Aadhaar number: mandatory at registration, nullable in the database.
-- Vendors are never deleted, so rows registered before this column existed
-- have no number and NOT NULL would have needed a fabricated value for each.
-- Postgres allows many NULLs under a unique index, so the constraint binds
-- only the rows that carry one.
ALTER TABLE "vendor" ADD COLUMN "aadhar_number" TEXT;
CREATE UNIQUE INDEX "vendor_aadhar_number_key" ON "vendor"("aadhar_number");
