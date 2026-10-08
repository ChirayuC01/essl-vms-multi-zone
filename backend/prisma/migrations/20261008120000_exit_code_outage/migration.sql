-- Two-zone rebuild, Phase 7: exit code, out-pass links, outage recovery.
-- Additive: a nullable request on link tokens (out-pass links belong to a
-- pass), two nullable columns on entry, a new outage table, and the new
-- "outages:view" access cell granted to the seeded Security roles.

-- DropForeignKey
ALTER TABLE "link_token" DROP CONSTRAINT "link_token_request_id_fkey";

-- AlterTable
ALTER TABLE "entry" ADD COLUMN     "exit_code_sent_at" TIMESTAMP(3),
ADD COLUMN     "released_by_outage_id" TEXT;

-- AlterTable
ALTER TABLE "link_token" ADD COLUMN     "entry_id" TEXT,
ALTER COLUMN "request_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "outage" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "released_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outage_started_at_idx" ON "outage"("started_at");

-- CreateIndex
CREATE INDEX "link_token_entry_id_purpose_idx" ON "link_token"("entry_id", "purpose");

-- AddForeignKey
ALTER TABLE "entry" ADD CONSTRAINT "entry_released_by_outage_id_fkey" FOREIGN KEY ("released_by_outage_id") REFERENCES "outage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_token" ADD CONSTRAINT "link_token_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "visit_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_token" ADD CONSTRAINT "link_token_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Seed: Security and Security In-charge reconcile their manual admin-card

-- register against the outage list. Roles an Admin deleted are skipped.

INSERT INTO "role_permission" ("role_id", "permission")

SELECT r."id", 'outages:view' FROM "role" r WHERE r."id" IN ('role_security', 'role_security_incharge')

ON CONFLICT DO NOTHING;
