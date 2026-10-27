-- Logging integrity: activity log and archive manifests are append-only.
-- Activity rows may only be removed through td_purge_activity(), which by default refuses
-- to delete any day that has not been archived first.

CREATE OR REPLACE FUNCTION td_activity_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('td.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'table % is append-only (% blocked; use td_purge_activity for retention)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER activity_log_append_only BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION td_activity_guard();
--> statement-breakpoint
CREATE TRIGGER activity_log_no_truncate BEFORE TRUNCATE ON activity_log
  FOR EACH STATEMENT EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint
CREATE TRIGGER log_archives_append_only BEFORE UPDATE OR DELETE ON log_archives
  FOR EACH ROW EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint
CREATE TRIGGER log_archives_no_truncate BEFORE TRUNCATE ON log_archives
  FOR EACH STATEMENT EXECUTE FUNCTION td_block_mutation();
--> statement-breakpoint

-- Retention: delete activity rows older than the cutoff, only for archived UTC days (unless require_archive = false).
CREATE OR REPLACE FUNCTION td_purge_activity(cutoff timestamptz, require_archive boolean DEFAULT true) RETURNS bigint AS $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('td.purge', 'on', true);
  DELETE FROM activity_log a
   WHERE a.at < cutoff
     AND (NOT require_archive OR EXISTS (
       SELECT 1 FROM log_archives l
        WHERE l.kind = 'activity' AND l.day = to_char(a.at AT TIME ZONE 'UTC', 'YYYY-MM-DD')));
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('td.purge', 'off', true);
  RETURN n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
--> statement-breakpoint

ALTER TABLE activity_log ADD CONSTRAINT activity_outcome_ck CHECK (outcome IN ('OK', 'ERROR'));
--> statement-breakpoint
ALTER TABLE log_archives ADD CONSTRAINT log_archives_kind_ck CHECK (kind IN ('audit', 'activity'));
