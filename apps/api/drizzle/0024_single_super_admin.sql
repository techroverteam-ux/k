-- Keep the existing primary admin (username admin preferred), preserve retired identities for audit references.
WITH ranked AS (
 SELECT id, row_number() OVER (ORDER BY (username = 'admin') DESC, created_at, id) AS rank
 FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE'
)
UPDATE users SET status = 'SUSPENDED', updated_at = now() WHERE id IN (SELECT id FROM ranked WHERE rank > 1);
--> statement-breakpoint
UPDATE sessions SET revoked_at = now(), revoked_reason = 'ADMIN_RETIRED'
WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE role = 'SUPER_ADMIN' AND status <> 'ACTIVE');
--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_active_super_admin" ON "users" USING btree ("role") WHERE "users"."role" = 'SUPER_ADMIN' AND "users"."status" = 'ACTIVE';