-- The admin list filters by mode and pages by id.
CREATE INDEX broadcasts_mode ON broadcasts (mode, id DESC);
-- The stuck-send sweep checks the least recently checked rows first.
ALTER TABLE broadcasts ADD COLUMN checked_at INTEGER;
-- Item lists filter by outcome.
CREATE INDEX broadcast_items_outcome ON broadcast_items (broadcast_id, outcome, pass_id);
