-- Scanner authority is credential_epoch (0052); updated_at is a label, so credential changes need not advance it.
-- Only the admin config stale check still reads it, so keep it from moving backwards.
DROP TRIGGER IF EXISTS scanners_credential_revision;
CREATE TRIGGER scanners_updated_at_monotonic BEFORE UPDATE OF updated_at ON scanners
WHEN NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'scanner updated_at must not decrease');
END;
