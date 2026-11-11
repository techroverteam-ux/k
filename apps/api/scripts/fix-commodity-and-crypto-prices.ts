import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://tradedesk:tradedesk_dev@127.0.0.1:5432/tradedesk',
});

async function run() {
  console.log('Fixing commodity and crypto prices & tick sizes...');

  // 1. Bitcoin -> 80,078.18 (8007818 minor units), tick 100 (1.00)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 8007818, tick_minor = 100
    WHERE symbol LIKE '%BTC%'
  `);

  // 2. MCX Gold -> ~₹78,500.00 (7850000 minor units), tick 100 (₹1.00)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 7850000, tick_minor = 100
    WHERE exchange = 'MCX' AND (symbol LIKE 'GOLD%' OR symbol LIKE 'GOLDM%') AND symbol NOT LIKE 'GOLDG%' AND symbol NOT LIKE 'GOLDP%'
  `);

  // Gold Guinea (8g) -> ~₹62,800.00
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 6280000, tick_minor = 100
    WHERE exchange = 'MCX' AND symbol LIKE 'GOLDGUINEA%'
  `);

  // Gold Petal (1g) -> ~₹7,850.00
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 785000, tick_minor = 100
    WHERE exchange = 'MCX' AND symbol LIKE 'GOLDPETAL%'
  `);

  // 3. MCX Silver -> ~₹92,500.00 (9250000 minor units), tick 100 (₹1.00)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 9250000, tick_minor = 100
    WHERE exchange = 'MCX' AND symbol LIKE 'SILVER%'
  `);

  // 4. MCX Crude Oil -> ~₹5,850.00 (585000 minor units), tick 100 (₹1.00)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 585000, tick_minor = 100
    WHERE exchange = 'MCX' AND symbol LIKE 'CRUDEOIL%'
  `);

  // 5. MCX Natural Gas -> ~₹245.00 (24500 minor units), tick 10 (₹0.10)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 24500, tick_minor = 10
    WHERE exchange = 'MCX' AND (symbol LIKE 'NATURALGAS%' OR symbol LIKE 'NATGAS%')
  `);

  // 6. MCX Copper -> ~₹815.00 (81500 minor units), tick 5 (₹0.05)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 81500, tick_minor = 5
    WHERE exchange = 'MCX' AND symbol LIKE 'COPPER%'
  `);

  // 7. MCX Zinc -> ~₹265.00 (26500 minor units), tick 5 (₹0.05)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 26500, tick_minor = 5
    WHERE exchange = 'MCX' AND symbol LIKE 'ZINC%'
  `);

  // 8. MCX Lead -> ~₹182.00 (18200 minor units), tick 5 (₹0.05)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 18200, tick_minor = 5
    WHERE exchange = 'MCX' AND symbol LIKE 'LEAD%'
  `);

  // 9. MCX Aluminium -> ~₹232.00 (23200 minor units), tick 5 (₹0.05)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 23200, tick_minor = 5
    WHERE exchange = 'MCX' AND symbol LIKE 'ALUM%'
  `);

  // 10. MCX Mentha Oil -> ~₹920.00 (92000 minor units), tick 10 (₹0.10)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 92000, tick_minor = 10
    WHERE exchange = 'MCX' AND symbol LIKE 'MENTHAOIL%'
  `);

  // 11. MCX Kapas -> ~₹1,540.00 (154000 minor units), tick 50 (₹0.50)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 154000, tick_minor = 50
    WHERE exchange = 'MCX' AND symbol LIKE 'KAPAS%'
  `);

  // 12. MCX Cotton Candy -> ~₹54,500.00 (5450000 minor units), tick 2000 (₹20.00)
  await pool.query(`
    UPDATE instruments
    SET ref_price_minor = 5450000, tick_minor = 2000
    WHERE exchange = 'MCX' AND (symbol LIKE 'COTTON%' OR symbol LIKE 'COTTONCNDY%')
  `);

  const btcRow = await pool.query("SELECT symbol, name, ref_price_minor, tick_minor FROM instruments WHERE symbol LIKE '%BTC%'");
  console.log('Updated BTC:', btcRow.rows);

  const goldRow = await pool.query("SELECT symbol, name, ref_price_minor, tick_minor FROM instruments WHERE id = '57f75db5-2d08-4eb4-85b1-eed84d9d36de'");
  console.log('Updated Gold:', goldRow.rows);

  await pool.end();
  console.log('Done!');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

