-- AlterTable
ALTER TABLE "device" ADD COLUMN     "punch_baseline_at" TIMESTAMP(3),
ADD COLUMN     "punch_baseline_device_count" INTEGER,
ADD COLUMN     "punch_baseline_local_count" INTEGER;
