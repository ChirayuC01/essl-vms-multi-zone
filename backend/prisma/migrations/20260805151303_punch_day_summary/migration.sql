-- CreateTable
CREATE TABLE "punch_day_summary" (
    "id" TEXT NOT NULL,
    "essl_user_id" INTEGER NOT NULL,
    "vendor_id" TEXT,
    "device_id" TEXT NOT NULL,
    "local_date" TEXT NOT NULL,
    "first_punch_utc" TIMESTAMP(3) NOT NULL,
    "last_punch_utc" TIMESTAMP(3) NOT NULL,
    "punch_count" INTEGER NOT NULL,
    "in_count" INTEGER NOT NULL,
    "out_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "punch_day_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "punch_day_summary_local_date_idx" ON "punch_day_summary"("local_date");

-- CreateIndex
CREATE INDEX "punch_day_summary_vendor_id_idx" ON "punch_day_summary"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "punch_day_summary_essl_user_id_device_id_local_date_key" ON "punch_day_summary"("essl_user_id", "device_id", "local_date");
