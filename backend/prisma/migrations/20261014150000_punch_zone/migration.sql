-- F3 F-z: every punch records the zone its terminal was in at the time, so
-- attendance by zone (F4) stays correct after a terminal moves or a zone is
-- re-parented. Existing punches take their terminal's current zone: the best
-- that can be known now. Not a foreign key: history outlives zone changes.
ALTER TABLE "punch_event" ADD COLUMN "zone_id" TEXT;

UPDATE "punch_event" p
   SET "zone_id" = d."zone_id"
  FROM "device" d
 WHERE d."id" = p."device_id" AND d."zone_id" IS NOT NULL;

CREATE INDEX "punch_event_zone_id_idx" ON "punch_event"("zone_id");
