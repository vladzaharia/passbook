-- Scanner authority is credential_epoch (0052); updated_at is a label, so credential changes need not advance it.
DROP TRIGGER IF EXISTS scanners_credential_revision;
