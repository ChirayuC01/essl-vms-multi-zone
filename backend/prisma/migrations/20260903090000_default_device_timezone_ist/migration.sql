-- Devices adopted through the operator API inherited the original UTC
-- default even though this India deployment receives local IST wall time
-- from its terminals. That made punch-derived displays 5h30 late after the
-- presentation layer correctly converted the wrongly-normalized value.

CREATE TEMP TABLE "_vms_zero_offset_device" ON COMMIT DROP AS
SELECT "id"
  FROM "device"
 WHERE "timezone_offset_minutes" = 0;

ALTER TABLE "device"
  ALTER COLUMN "timezone_offset_minutes" SET DEFAULT 330;

-- Correct raw normalized instants first. punched_at_device deliberately stays
-- unchanged: it is the terminal's original wall-clock record.
UPDATE "punch_event" p
   SET "punched_at_utc" = p."punched_at_utc" - INTERVAL '5 hours 30 minutes'
  FROM "_vms_zero_offset_device" d
 WHERE p."device_id" = d."id";

-- Entry crossing timestamps are denormalized from their linked punches.
-- Recompute affected entries from all their punches so a multi-device entry
-- remains correct even when only one terminal had the bad default.
WITH affected_entries AS (
  SELECT DISTINCT p."entry_id"
    FROM "punch_event" p
    JOIN "_vms_zero_offset_device" d ON d."id" = p."device_id"
   WHERE p."entry_id" IS NOT NULL
), crossing_times AS (
  SELECT p."entry_id",
         MAX(p."punched_at_utc") FILTER (WHERE p."direction" = 'IN'::"PunchDirection") AS "in_at",
         MAX(p."punched_at_utc") FILTER (WHERE p."direction" = 'OUT'::"PunchDirection") AS "out_at"
    FROM "punch_event" p
    JOIN affected_entries a ON a."entry_id" = p."entry_id"
   GROUP BY p."entry_id"
)
UPDATE "entry" e
   SET "in_at" = c."in_at",
       "out_at" = c."out_at"
  FROM crossing_times c
 WHERE e."id" = c."entry_id";

-- A retained summary can be shifted safely only when every contributing
-- terminal had the same erroneous zero offset. Mixed-device summaries no
-- longer contain enough raw detail to identify which terminal supplied each
-- boundary, so they are intentionally left for review rather than guessed.
UPDATE "attendance_day_summary" s
   SET "first_in_utc" = s."first_in_utc" - INTERVAL '5 hours 30 minutes',
       "last_out_utc" = s."last_out_utc" - INTERVAL '5 hours 30 minutes'
 WHERE CARDINALITY(s."device_ids") > 0
   AND NOT EXISTS (
     SELECT 1
       FROM UNNEST(s."device_ids") AS ids(device_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM "_vms_zero_offset_device" d WHERE d."id" = device_id
      )
   );

UPDATE "device"
   SET "timezone_offset_minutes" = 330
 WHERE "id" IN (SELECT "id" FROM "_vms_zero_offset_device");
