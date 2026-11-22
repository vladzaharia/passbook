-- OC4: a tap-out of a voided, expired or suspended pass says which state the pass was in.
ALTER TABLE scans ADD COLUMN pass_state TEXT CHECK (pass_state IS NULL OR pass_state IN ('voided', 'expired', 'suspended'));
