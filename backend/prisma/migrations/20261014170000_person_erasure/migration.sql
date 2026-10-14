-- F2 #1b: erasure on request (Administrator only). Marks a person whose
-- identity, photo and documents were wiped; the row, ID and history remain.
ALTER TABLE "person" ADD COLUMN "erased_at" TIMESTAMP(3);
