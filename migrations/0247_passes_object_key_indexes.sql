-- The pass object GC (passes.object_gc) asks, per R2 key, whether a removal claim or a boundary still points at
-- it; neither column had an index, so each key scanned the table.
CREATE INDEX passes_removal_claim_r2 ON passes (removal_claim_object_key);
CREATE INDEX pass_boundaries_r2 ON pass_boundaries (object_key);
