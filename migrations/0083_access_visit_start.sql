-- An Access card's visit gate measures the gap from the visit's start, not its last grant.
ALTER TABLE scan_gates ADD COLUMN visit_at INTEGER;
ALTER TABLE scan_gates ADD COLUMN prev_visit_at INTEGER;
