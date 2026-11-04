ALTER TABLE "instruments" ADD COLUMN "lot_label" varchar(40);--> statement-breakpoint
UPDATE "instruments" SET "lot_class" = CASE WHEN "exchange" = 'MCX' AND substring(upper("symbol") from '^[A-Z&]+') !~ '^(GOLDM|GOLDPETAL|GOLDGUINEA|GOLDTEN|SILVERM|SILVERMIC|CRUDEOILM|NATGASMINI|ZINCMINI|LEADMINI|ALUMINI|COPPERM)$' THEN 'MEGA' ELSE 'MINI' END;--> statement-breakpoint
UPDATE "instruments" SET "lot_label" = CASE substring(upper("symbol") from '^[A-Z&]+')
    WHEN 'GOLD' THEN '1 kg'
    WHEN 'GOLDM' THEN '100 g'
    WHEN 'GOLDGUINEA' THEN '8 g'
    WHEN 'GOLDPETAL' THEN '1 g'
    WHEN 'SILVER' THEN '30 kg'
    WHEN 'SILVERM' THEN '5 kg'
    WHEN 'SILVERMIC' THEN '1 kg'
    WHEN 'CRUDEOIL' THEN '100 barrels'
    WHEN 'CRUDEOILM' THEN '10 barrels'
    WHEN 'NATURALGAS' THEN '1,250 mmBtu'
    WHEN 'NATGASMINI' THEN '250 mmBtu'
    WHEN 'COPPER' THEN '2,500 kg'
    WHEN 'ZINCMINI' THEN '1 tonne'
    WHEN 'LEADMINI' THEN '1 tonne'
    WHEN 'ALUMINI' THEN '1 tonne'
    WHEN 'USDINR' THEN '1,000 USD'
    WHEN 'EURINR' THEN '1,000 EUR'
    WHEN 'GBPINR' THEN '1,000 GBP'
    WHEN 'JPYINR' THEN '1,00,000 JPY'
  END;
