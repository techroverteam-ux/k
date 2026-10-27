-- Consent records are evidence: never updated or deleted.
CREATE TRIGGER trading_consents_append_only BEFORE UPDATE OR DELETE ON trading_consents
  FOR EACH ROW EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint
CREATE TRIGGER trading_consents_no_truncate BEFORE TRUNCATE ON trading_consents
  FOR EACH STATEMENT EXECUTE FUNCTION td_block_mutation();
