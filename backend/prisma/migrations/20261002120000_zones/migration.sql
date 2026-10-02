-- Two-zone rebuild, Phase 1: site topology.
--
-- Additive only. Every existing device keeps zone_id NULL ("not yet placed"),
-- which zone-based access never selects, so upgrading changes no behaviour
-- until an Admin places terminals into zones.

CREATE TABLE "zone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_zone_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "exit_code_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zone_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "zone_parent_zone_id_idx" ON "zone"("parent_zone_id");

-- Names are unique case-insensitively, like companies and departments.
CREATE UNIQUE INDEX "zone_name_ci_key" ON "zone" (UPPER("name"));

ALTER TABLE "zone" ADD CONSTRAINT "zone_parent_zone_id_fkey"
  FOREIGN KEY ("parent_zone_id") REFERENCES "zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "device" ADD COLUMN "zone_id" TEXT;

CREATE INDEX "device_zone_id_idx" ON "device"("zone_id");

ALTER TABLE "device" ADD CONSTRAINT "device_zone_id_fkey"
  FOREIGN KEY ("zone_id") REFERENCES "zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
