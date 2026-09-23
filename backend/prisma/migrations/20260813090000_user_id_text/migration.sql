-- The device user ID becomes TEXT.
--
-- Real terminals hold IDs like `WCTPL070`, `wctpl101` and `ye01` beside plain
-- numbers, and an integer column could not represent them: a punch by
-- `WCTPL070` parsed to NaN and was silently discarded before it was ever
-- stored. Existing values convert unchanged -- 10008 becomes '10008', the same
-- identity, so nothing is re-keyed and no data moves.
--
-- One-way in practice: once a site registers an alphanumeric ID, the column
-- cannot go back to an integer.

ALTER TABLE "vendor" ALTER COLUMN "essl_user_id" TYPE TEXT USING "essl_user_id"::text;
ALTER TABLE "punch_event" ALTER COLUMN "essl_user_id" TYPE TEXT USING "essl_user_id"::text;
ALTER TABLE "punch_day_summary" ALTER COLUMN "essl_user_id" TYPE TEXT USING "essl_user_id"::text;

-- Uniqueness becomes case-INSENSITIVE.
--
-- One roster observed in the field carries `wctpl070` and `WCTPL071` side by
-- side, so the casing plainly means nothing to the site. Two vendor rows
-- differing only in case would also collide on disk: Postgres is
-- case-sensitive and NTFS is not, so `photos/ABC1.jpg` and `photos/abc1.jpg`
-- are one file, and one vendor's enrollment photo would silently overwrite
-- another's.
--
-- A functional index rather than a plain UNIQUE because Prisma cannot express
-- UPPER() in the schema; the column is therefore not marked @unique there.
-- DROP INDEX, not DROP CONSTRAINT: Prisma's @unique creates a plain unique
-- index, and dropping it as a constraint fails with "does not exist".
DROP INDEX "vendor_essl_user_id_key";
CREATE UNIQUE INDEX "vendor_essl_user_id_upper_key" ON "vendor" (UPPER("essl_user_id"));
