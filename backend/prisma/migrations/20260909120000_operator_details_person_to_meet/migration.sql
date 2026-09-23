-- Additive upgrade: existing operators and entries retain all data and receive
-- NULL for the new optional fields.
ALTER TABLE "app_user"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "phone" TEXT;

ALTER TABLE "entry" ADD COLUMN "person_to_meet_id" TEXT;

CREATE INDEX "entry_person_to_meet_id_idx" ON "entry"("person_to_meet_id");

ALTER TABLE "entry"
  ADD CONSTRAINT "entry_person_to_meet_id_fkey"
  FOREIGN KEY ("person_to_meet_id") REFERENCES "app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
