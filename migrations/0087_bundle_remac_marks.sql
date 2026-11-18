-- A bundle link changes only by a rotation (which moves token_rotated_at) or by the cron tokens.remac
-- re-MAC (0069 did this for passes): the job writes a mark naming exactly the new MAC, updates the token and
-- deletes the mark in one batch. Any other write of a different MAC is refused.
CREATE TABLE bundle_remac_marks (
  bundle_id TEXT NOT NULL PRIMARY KEY REFERENCES bundles (id) ON DELETE CASCADE,
  mac TEXT NOT NULL CHECK (mac GLOB 'h1:*')
) WITHOUT ROWID;

CREATE TRIGGER bundles_token_change_moves_rotation BEFORE UPDATE OF token ON bundles
WHEN NEW.token IS NOT OLD.token AND NEW.token_rotated_at IS OLD.token_rotated_at
  AND NOT EXISTS (SELECT 1 FROM bundle_remac_marks m WHERE m.bundle_id = OLD.id AND m.mac = NEW.token)
BEGIN SELECT RAISE(ABORT, 'a bundle token change must move token_rotated_at'); END;
