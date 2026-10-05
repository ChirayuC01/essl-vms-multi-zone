-- Two-zone rebuild, Phase 2: operator roles.
-- Additive: existing ADMIN and AUTHORIZED_PERSON accounts are untouched.
ALTER TYPE "UserRole" ADD VALUE 'HOST';
ALTER TYPE "UserRole" ADD VALUE 'SECURITY';
ALTER TYPE "UserRole" ADD VALUE 'SECURITY_INCHARGE';
ALTER TYPE "UserRole" ADD VALUE 'HR';
ALTER TYPE "UserRole" ADD VALUE 'HOD';
