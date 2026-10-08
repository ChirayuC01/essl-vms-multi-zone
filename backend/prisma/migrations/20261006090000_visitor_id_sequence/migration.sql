-- Two-zone rebuild, Phase 6: system-issued visitor terminal IDs.
--
-- A cleared request for a new visitor gets <visitorIdPrefix><number>, the
-- number from this sequence (atomic, never reused). Not a Prisma model: it
-- is read with nextval() in services/visit-review.ts.
CREATE SEQUENCE IF NOT EXISTS "visitor_id_seq" START 1;
