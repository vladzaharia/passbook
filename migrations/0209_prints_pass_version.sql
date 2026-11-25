-- The pass version a print was made from; null for prints made before this column. Not a key column: pass_prints_key does not guard it.
ALTER TABLE pass_prints ADD COLUMN pass_version INTEGER;
