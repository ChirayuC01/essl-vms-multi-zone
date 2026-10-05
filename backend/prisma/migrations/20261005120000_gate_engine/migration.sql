-- Two-zone rebuild, Phase 4: the gate engine.
--
-- An entry becomes a pass (extended in place: its retention window is its
-- validity). Each pass gets one pass_gate row per terminal saying when the
-- face arrives and leaves.
--
-- What an upgraded site sees: every live entry gets gate rows for exactly the
-- terminals it was provisioned to, in the state it is actually in, so no
-- loaded face is lost or pushed again. Closed entries get none. Old SINGLE_ENTRY
-- day-blocking is retired: an entry blocked for the day stays blocked until
-- its window ends (precondition for upgrade: no multi-day single-entry passes
-- that need re-entry on later days).

CREATE TYPE "GateState" AS ENUM ('PENDING', 'LOADING', 'LOADED', 'UNLOADING', 'DONE');
CREATE TYPE "GateReason" AS ENUM ('SCHEDULE', 'EXIT_CODE', 'OVERRIDE', 'WIDEN', 'MIGRATED');

ALTER TABLE "entry"
  ADD COLUMN "pass_type_id" TEXT,
  ADD COLUMN "zone_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "exit_code_zone_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "location_zone_id" TEXT;
ALTER TABLE "entry" ADD CONSTRAINT "entry_pass_type_id_fkey"
  FOREIGN KEY ("pass_type_id") REFERENCES "pass_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "person"
  ADD COLUMN "blacklisted_at" TIMESTAMP(3),
  ADD COLUMN "blacklisted_by" TEXT,
  ADD COLUMN "blacklist_reason" TEXT;

CREATE TABLE "pass_gate" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "state" "GateState" NOT NULL DEFAULT 'PENDING',
    "reason" "GateReason" NOT NULL DEFAULT 'SCHEDULE',
    "load_at" TIMESTAMP(3) NOT NULL,
    "unload_at" TIMESTAMP(3),
    "loaded_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pass_gate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pass_gate_entry_id_device_id_key" ON "pass_gate"("entry_id", "device_id");
CREATE INDEX "pass_gate_state_load_at_idx" ON "pass_gate"("state", "load_at");
CREATE INDEX "pass_gate_state_unload_at_idx" ON "pass_gate"("state", "unload_at");
CREATE INDEX "pass_gate_device_id_state_idx" ON "pass_gate"("device_id", "state");
ALTER TABLE "pass_gate" ADD CONSTRAINT "pass_gate_entry_id_fkey"
  FOREIGN KEY ("entry_id") REFERENCES "entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pass_gate" ADD CONSTRAINT "pass_gate_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one row per live entry per terminal it was provisioned to. The
-- state follows the entry's own: provisioned/inside = the face is there.
INSERT INTO "pass_gate" ("id", "entry_id", "device_id", "state", "reason", "load_at", "unload_at", "loaded_at", "updated_at")
SELECT DISTINCT ON (e."id", sc."target_device_id")
       'gate_' || md5(e."id" || sc."target_device_id"),
       e."id",
       sc."target_device_id",
       CASE e."state"
         WHEN 'PENDING_PROVISION' THEN 'LOADING'::"GateState"
         WHEN 'PENDING_DEPROVISION' THEN 'UNLOADING'::"GateState"
         ELSE 'LOADED'::"GateState"
       END,
       'MIGRATED'::"GateReason",
       e."created_at",
       e."retention_expires_at",
       CASE WHEN e."state" IN ('PROVISIONED', 'INSIDE') THEN e."created_at" END,
       CURRENT_TIMESTAMP
  FROM "entry" e
  JOIN "sync_command" sc ON sc."entry_id" = e."id" AND sc."type" = 'PROVISION'::"CommandType"
 WHERE e."state" IN ('PENDING_PROVISION', 'PROVISIONED', 'INSIDE', 'PENDING_DEPROVISION');
