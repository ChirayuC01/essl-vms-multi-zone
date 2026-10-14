-- F2 #6 (client, 14 Oct 2026): hosts may add a company or department from
-- the request form. Grants the seeded Host role `directory:create`; an Admin
-- can still take it away on the Access page. Additive, idempotent.
INSERT INTO "role_permission" ("role_id", "permission")
SELECT r."id", 'directory:create' FROM "role" r WHERE r."key" = 'HOST'
ON CONFLICT DO NOTHING;
