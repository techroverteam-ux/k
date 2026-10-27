-- Price columns per order type. Compares type as text so it works in the same transaction
-- that added the new enum values.
ALTER TABLE orders DROP CONSTRAINT orders_limit_price;
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_price_by_type CHECK (
  (type::text = 'MARKET' AND limit_price_minor IS NULL AND trigger_price_minor IS NULL)
  OR (type::text = 'LIMIT' AND limit_price_minor > 0 AND trigger_price_minor IS NULL)
  OR (type::text IN ('STOP_LOSS', 'TAKE_PROFIT') AND limit_price_minor IS NULL AND trigger_price_minor > 0)
);
