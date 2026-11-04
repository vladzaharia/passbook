-- Remote remove: what a restore needs to undo it, and what later publishes of a removed pass keep.
ALTER TABLE passes ADD COLUMN removal_message TEXT;
ALTER TABLE passes ADD COLUMN removal_prior_status TEXT;
