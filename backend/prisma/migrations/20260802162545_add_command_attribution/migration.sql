-- AlterTable
ALTER TABLE "sync_command" ADD COLUMN     "initiated_by" TEXT;

-- CreateIndex
CREATE INDEX "sync_command_initiated_by_idx" ON "sync_command"("initiated_by");

-- AddForeignKey
ALTER TABLE "sync_command" ADD CONSTRAINT "sync_command_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
