-- Two-zone rebuild, Phase 5: visit requests, the visitor portal, the
-- messaging outbox, one-time codes and consent records.
--
-- What an upgraded site sees: new tables only. person_document gains an
-- optional link to a visit request (a visitor's upload before they are a
-- person), so person_id becomes nullable; every existing row keeps its person.

-- CreateEnum
CREATE TYPE "VisitRequestStatus" AS ENUM ('SENT', 'SUBMITTED', 'QUERIED', 'CLEARED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VisitOrigin" AS ENUM ('PLANNED', 'WALK_IN');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'FAILED');

-- DropForeignKey
ALTER TABLE "person_document" DROP CONSTRAINT "person_document_person_id_fkey";

-- AlterTable
ALTER TABLE "person_document" ADD COLUMN     "visit_request_id" TEXT,
ALTER COLUMN "person_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "visit_request" (
    "id" TEXT NOT NULL,
    "host_id" TEXT NOT NULL,
    "origin" "VisitOrigin" NOT NULL DEFAULT 'PLANNED',
    "status" "VisitRequestStatus" NOT NULL DEFAULT 'SENT',
    "visitor_name" TEXT NOT NULL,
    "visitor_mobile" TEXT NOT NULL,
    "visitor_email" TEXT,
    "company_name" TEXT,
    "purpose" TEXT NOT NULL,
    "pass_type_id" TEXT,
    "zone_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exit_code_zone_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "entry_mode" "EntryMode" NOT NULL DEFAULT 'SINGLE_ENTRY',
    "expected_at" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "person_id" TEXT,
    "submission" JSONB,
    "selfie_path" TEXT,
    "mobile_verified_at" TIMESTAMP(3),
    "consented_at" TIMESTAMP(3),
    "query_text" TEXT,
    "pass_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visit_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visit_request_event" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_kind" TEXT NOT NULL,
    "from_status" "VisitRequestStatus",
    "to_status" "VisitRequestStatus" NOT NULL,
    "note" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_request_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_token" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "error" TEXT,
    "transport" TEXT NOT NULL,
    "related_type" TEXT,
    "related_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "notice_version" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visit_request_host_id_status_idx" ON "visit_request"("host_id", "status");

-- CreateIndex
CREATE INDEX "visit_request_status_idx" ON "visit_request"("status");

-- CreateIndex
CREATE INDEX "visit_request_visitor_mobile_idx" ON "visit_request"("visitor_mobile");

-- CreateIndex
CREATE INDEX "visit_request_event_request_id_created_at_idx" ON "visit_request_event"("request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "link_token_token_hash_key" ON "link_token"("token_hash");

-- CreateIndex
CREATE INDEX "link_token_request_id_purpose_idx" ON "link_token"("request_id", "purpose");

-- CreateIndex
CREATE INDEX "otp_purpose_subject_id_created_at_idx" ON "otp"("purpose", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "message_created_at_idx" ON "message"("created_at");

-- CreateIndex
CREATE INDEX "message_related_type_related_id_idx" ON "message"("related_type", "related_id");

-- CreateIndex
CREATE INDEX "consent_record_request_id_idx" ON "consent_record"("request_id");

-- CreateIndex
CREATE INDEX "person_document_visit_request_id_idx" ON "person_document"("visit_request_id");

-- AddForeignKey
ALTER TABLE "person_document" ADD CONSTRAINT "person_document_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_document" ADD CONSTRAINT "person_document_visit_request_id_fkey" FOREIGN KEY ("visit_request_id") REFERENCES "visit_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_request" ADD CONSTRAINT "visit_request_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_request_event" ADD CONSTRAINT "visit_request_event_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "visit_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_token" ADD CONSTRAINT "link_token_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "visit_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "visit_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

