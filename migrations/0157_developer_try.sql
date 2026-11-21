-- Try tokens (PX8). A `pbtry_` token carries the sandbox's generation when it was made; raising it ends every
-- token of the sandbox at once, without signing the person out or revoking the key.
ALTER TABLE developer_sandboxes ADD COLUMN try_generation INTEGER NOT NULL DEFAULT 1 CHECK (try_generation >= 1);

CREATE TRIGGER developer_sandboxes_try_generation_monotonic BEFORE UPDATE OF try_generation ON developer_sandboxes
WHEN NEW.try_generation < OLD.try_generation
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
