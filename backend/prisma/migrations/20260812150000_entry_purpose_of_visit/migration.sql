-- Why a visit was authorized, captured at provision time alongside the
-- retention window and entry mode. Required by the API; nullable here because
-- entries authorized before this column existed have nothing to put in it,
-- and an authorization record is never rewritten after the fact.
ALTER TABLE "entry" ADD COLUMN "purpose_of_visit" TEXT;
