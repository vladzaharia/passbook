-- Removal and restore claims need a durable generation distinct from pass versions and links.
ALTER TABLE passes ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 0
  CHECK (lifecycle_generation >= 0);
ALTER TABLE passes ADD COLUMN removal_published_generation INTEGER;
ALTER TABLE passes ADD COLUMN removal_claim_version INTEGER;
ALTER TABLE passes ADD COLUMN removal_claim_status TEXT
  CHECK (removal_claim_status IS NULL OR removal_claim_status IN ('active', 'voided'));
ALTER TABLE passes ADD COLUMN removal_claim_object_key TEXT;
ALTER TABLE passes ADD COLUMN removal_claim_link_generation INTEGER;

-- Cutover backfill (populated 0024 database): passes removed before this migration already
-- published their voided snapshot; mark that generation published so they can be removed again.
UPDATE passes SET removal_published_generation = lifecycle_generation
WHERE removed_at IS NOT NULL AND removal_published_generation IS NULL;
