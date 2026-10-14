-- F2 #10: which exits need the exit code moves from each zone's
-- "exit code by default" onto the pass type. Existing types that require the
-- code take today's default zones, so nothing changes at the gate. An
-- upgraded single-zone site has no default zones, so its types get none.
-- zone.exit_code_default stays (additive migrations) but is no longer read.
ALTER TABLE "pass_type" ADD COLUMN "exit_code_zone_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "pass_type"
   SET "exit_code_zone_ids" = ARRAY(SELECT z."id" FROM "zone" z WHERE z."exit_code_default" = true AND z."is_active" = true ORDER BY z."name")
 WHERE "exit_code_required" = true;
