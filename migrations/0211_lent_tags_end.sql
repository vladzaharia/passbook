-- A loaner (a tag whose type has use 'visitor') is lent to a pass: its binding ends by itself when the pass is
-- voided or removed. The window end is the binding's own expires_at; the desk return is an ordinary unbind.
-- Same stamp, actor and cause as passes_tag_bindings_follow (0088). Other tags are left alone.
CREATE TRIGGER passes_lent_tags_end AFTER UPDATE OF status, removed_at ON passes
WHEN (NEW.status = 'voided' AND OLD.status IS NOT 'voided')
  OR (NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL)
BEGIN
  UPDATE tag_bindings SET ended_at = CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER), ended_by_type = 'system',
    ended_by = 'passes', end_cause = 'pass_ended'
  WHERE pass_id = NEW.id AND scope = 'pass' AND ended_at IS NULL
    AND EXISTS (SELECT 1 FROM nfc_tags t JOIN nfc_tag_types y ON y.id = t.type_id
      WHERE t.id = tag_bindings.tag_id AND t.org_id = NEW.org_id AND y.org_id = NEW.org_id AND y.use = 'visitor');
END;

-- A loaner's expiry follows its pass's window, so a guest window that moves moves it too (nfc/lent-window.ts).
-- Every other binding keeps the rule of 0128: set at the bind, never moved.
DROP TRIGGER tag_bindings_expiry_fixed;
CREATE TRIGGER tag_bindings_expiry_fixed BEFORE UPDATE OF expires_at ON tag_bindings
WHEN NEW.expires_at IS NOT OLD.expires_at AND NOT EXISTS (
  SELECT 1 FROM nfc_tags t JOIN nfc_tag_types y ON y.id = t.type_id WHERE t.id = NEW.tag_id AND y.use = 'visitor')
BEGIN SELECT RAISE(ABORT, 'tag_binding_immutable'); END;
