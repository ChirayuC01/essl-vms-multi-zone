-- AlterTable
ALTER TABLE "device" ADD COLUMN     "duplicate_punch_period_minutes" INTEGER,
ADD COLUMN     "in_status_codes" INTEGER[] DEFAULT ARRAY[0]::INTEGER[],
ADD COLUMN     "out_status_codes" INTEGER[] DEFAULT ARRAY[1]::INTEGER[];
