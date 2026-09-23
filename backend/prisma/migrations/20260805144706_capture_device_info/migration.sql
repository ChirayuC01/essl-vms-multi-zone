-- AlterTable
ALTER TABLE "device" ADD COLUMN     "last_info" JSONB,
ADD COLUMN     "last_info_at" TIMESTAMP(3);
