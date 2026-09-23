-- Vendors whose face was enrolled on the terminal by someone else (adopted
-- from an unclaimed enrollment, or predating this installation). Existing
-- rows default to false: everything registered before this migration went
-- through the normal provision path.
ALTER TABLE "vendor" ADD COLUMN "adopted_from_device" BOOLEAN NOT NULL DEFAULT false;
