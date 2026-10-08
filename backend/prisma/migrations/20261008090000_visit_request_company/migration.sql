-- Two-zone rebuild, Phase 6: a visit request's company is chosen from the
-- directory (host / Security), no longer typed by the visitor. Additive;
-- company_name stays as a display snapshot and for earlier requests.

-- AlterTable
ALTER TABLE "visit_request" ADD COLUMN     "company_id" TEXT;

-- AddForeignKey
ALTER TABLE "visit_request" ADD CONSTRAINT "visit_request_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
