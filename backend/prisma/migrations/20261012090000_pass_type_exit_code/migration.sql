-- F1: the visitor type decides whether a single-entry exit needs the exit code.
-- Existing types keep today's behaviour (required).
ALTER TABLE "pass_type" ADD COLUMN "exit_code_required" BOOLEAN NOT NULL DEFAULT true;
