-- These subscriptions are ETFs, not the cash indices their old aliases suggested.
-- Rename catalog metadata only: instrument IDs, quantities, orders and ledger history stay intact.
UPDATE instruments i SET symbol = v.symbol, name = v.name, exchange = v.exchange,
  segment = 'US_STOCK', lot_label = '1 share'
FROM (VALUES
  ('SPX','SPY','SPDR S&P 500 ETF Trust','NYSE','10009619'),
  ('NDX','QQQ','Invesco QQQ Trust','NASDAQ','10008402'),
  ('DJI','DIA','SPDR Dow Jones Industrial Average ETF Trust','NYSE','10002663'),
  ('RUT','IWM','iShares Russell 2000 ETF','NYSE','10005457')
) AS v(old_symbol,symbol,name,exchange,security_id)
WHERE i.symbol = v.old_symbol AND i.dhan_segment = 'INX_EQ' AND i.dhan_security_id = v.security_id
AND NOT EXISTS (SELECT 1 FROM instruments existing WHERE existing.symbol = v.symbol);
