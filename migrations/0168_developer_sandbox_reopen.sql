-- A reopened org reopens its developer sandbox: closed_at and close_reason may be cleared together, never changed.
DROP TRIGGER developer_sandboxes_funnel_set_once;
CREATE TRIGGER developer_sandboxes_funnel_set_once
BEFORE UPDATE OF quickstart_viewed_at, first_call_at, first_pass_at, first_preview_at, first_live_key_at, closed_at, close_reason
ON developer_sandboxes
WHEN (OLD.quickstart_viewed_at IS NOT NULL AND NEW.quickstart_viewed_at IS NOT OLD.quickstart_viewed_at)
  OR (OLD.first_call_at IS NOT NULL AND NEW.first_call_at IS NOT OLD.first_call_at)
  OR (OLD.first_pass_at IS NOT NULL AND NEW.first_pass_at IS NOT OLD.first_pass_at)
  OR (OLD.first_preview_at IS NOT NULL AND NEW.first_preview_at IS NOT OLD.first_preview_at)
  OR (OLD.first_live_key_at IS NOT NULL AND NEW.first_live_key_at IS NOT OLD.first_live_key_at)
  OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT NULL
      AND (NEW.closed_at IS NOT OLD.closed_at OR NEW.close_reason IS NOT OLD.close_reason))
BEGIN SELECT RAISE(ABORT, 'a funnel column is set once'); END;
