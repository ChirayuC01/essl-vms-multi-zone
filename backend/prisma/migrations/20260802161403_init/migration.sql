-- CreateEnum
CREATE TYPE "EntryState" AS ENUM ('REGISTERED', 'PENDING_PROVISION', 'PROVISIONED', 'INSIDE', 'PENDING_DEPROVISION');

-- CreateEnum
CREATE TYPE "RetentionPolicy" AS ENUM ('ONE_DAY', 'ONE_WEEK', 'ONE_MONTH', 'QUARTERLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "EntryMode" AS ENUM ('SINGLE_ENTRY', 'MULTI_ENTRY');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'SENT', 'SUCCESS', 'FAILED', 'RETRY');

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('PROVISION', 'PUSH_PHOTO', 'DEPROVISION', 'BLOCK', 'UNBLOCK', 'QUERY_USER', 'DEVICE_INFO', 'CLEAR_LOGS');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'AUTHORIZED_PERSON');

-- CreateEnum
CREATE TYPE "DeviceRole" AS ENUM ('IN', 'OUT', 'BOTH');

-- CreateTable
CREATE TABLE "vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "mobile" TEXT,
    "essl_user_id" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_biometric" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "photo_path" TEXT NOT NULL,
    "photo_size_bytes" INTEGER,
    "face_template" TEXT,
    "algorithm_version" TEXT,
    "biometric_type" INTEGER NOT NULL DEFAULT 9,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_biometric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "state" "EntryState" NOT NULL DEFAULT 'REGISTERED',
    "expected_in_at" TIMESTAMP(3),
    "in_at" TIMESTAMP(3),
    "out_at" TIMESTAMP(3),
    "retention_policy" "RetentionPolicy" NOT NULL DEFAULT 'ONE_DAY',
    "retention_expires_at" TIMESTAMP(3),
    "entry_mode" "EntryMode" NOT NULL DEFAULT 'MULTI_ENTRY',
    "day_blocked" BOOLEAN NOT NULL DEFAULT false,
    "authorized_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "serial_no" TEXT NOT NULL,
    "ip" TEXT,
    "role" "DeviceRole" NOT NULL DEFAULT 'BOTH',
    "timezone_offset_minutes" INTEGER NOT NULL DEFAULT 0,
    "max_faces" INTEGER,
    "faces_used" INTEGER NOT NULL DEFAULT 0,
    "normal_group_id" INTEGER NOT NULL DEFAULT 1,
    "blocked_group_id" INTEGER NOT NULL DEFAULT 100,
    "firmware_version" TEXT,
    "algorithm_version" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "online" BOOLEAN NOT NULL DEFAULT false,
    "last_stamp" TEXT,
    "last_op_stamp" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_command" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT,
    "vendor_id" TEXT,
    "type" "CommandType" NOT NULL,
    "target_device_id" TEXT NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "device_cmd_id" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "payload" JSONB,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "sync_command_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "punch_event" (
    "id" TEXT NOT NULL,
    "essl_user_id" INTEGER NOT NULL,
    "device_id" TEXT NOT NULL,
    "punched_at_device" TIMESTAMP(3) NOT NULL,
    "punched_at_utc" TIMESTAMP(3) NOT NULL,
    "status_code" INTEGER,
    "verify_mode" INTEGER,
    "work_code" INTEGER,
    "raw_line" TEXT NOT NULL,
    "raw_record_hash" TEXT NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "punch_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'AUTHORIZED_PERSON',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "license" (
    "id" TEXT NOT NULL,
    "license_key" TEXT NOT NULL,
    "machine_fingerprint" TEXT,
    "plan" TEXT,
    "expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "grace_period_state" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "license_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_queue" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT,
    "entry_id" TEXT,
    "target_device_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_essl_user_id_key" ON "vendor"("essl_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_biometric_vendor_id_key" ON "vendor_biometric"("vendor_id");

-- CreateIndex
CREATE INDEX "entry_state_idx" ON "entry"("state");

-- CreateIndex
CREATE INDEX "entry_vendor_id_idx" ON "entry"("vendor_id");

-- CreateIndex
CREATE INDEX "entry_retention_expires_at_idx" ON "entry"("retention_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_serial_no_key" ON "device"("serial_no");

-- CreateIndex
CREATE UNIQUE INDEX "sync_command_idempotency_key_key" ON "sync_command"("idempotency_key");

-- CreateIndex
CREATE INDEX "sync_command_target_device_id_status_idx" ON "sync_command"("target_device_id", "status");

-- CreateIndex
CREATE INDEX "sync_command_status_idx" ON "sync_command"("status");

-- CreateIndex
CREATE UNIQUE INDEX "punch_event_raw_record_hash_key" ON "punch_event"("raw_record_hash");

-- CreateIndex
CREATE INDEX "punch_event_essl_user_id_idx" ON "punch_event"("essl_user_id");

-- CreateIndex
CREATE INDEX "punch_event_processed_idx" ON "punch_event"("processed");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log"("actor_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "license_license_key_key" ON "license"("license_key");

-- AddForeignKey
ALTER TABLE "vendor_biometric" ADD CONSTRAINT "vendor_biometric_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry" ADD CONSTRAINT "entry_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry" ADD CONSTRAINT "entry_authorized_by_fkey" FOREIGN KEY ("authorized_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_command" ADD CONSTRAINT "sync_command_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_command" ADD CONSTRAINT "sync_command_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_command" ADD CONSTRAINT "sync_command_target_device_id_fkey" FOREIGN KEY ("target_device_id") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_event" ADD CONSTRAINT "punch_event_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "punch_event" ADD CONSTRAINT "punch_event_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
