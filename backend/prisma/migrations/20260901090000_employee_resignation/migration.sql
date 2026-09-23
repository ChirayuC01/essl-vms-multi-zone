ALTER TABLE "person"
  ADD COLUMN "resigned_at" TIMESTAMP(3),
  ADD COLUMN "resigned_reason" TEXT,
  ADD COLUMN "resigned_by" TEXT;

CREATE INDEX "person_resigned_at_idx" ON "person"("resigned_at");

ALTER TABLE "person" ADD CONSTRAINT "person_resigned_by_fkey"
  FOREIGN KEY ("resigned_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
