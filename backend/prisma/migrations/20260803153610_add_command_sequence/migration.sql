-- AlterTable
ALTER TABLE "sync_command" ADD COLUMN     "seq" SERIAL NOT NULL;

-- CreateIndex
CREATE INDEX "sync_command_target_device_id_status_seq_idx" ON "sync_command"("target_device_id", "status", "seq");
