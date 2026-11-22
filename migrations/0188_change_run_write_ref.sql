-- The id of the change run whose write last set this pass, NULL after any other publish or metadata write.
-- A change run's settle reads it to tell whether its own write landed, including a write that adds no
-- version row. No trigger reads the column, so none is recreated.
ALTER TABLE passes ADD COLUMN write_ref TEXT;
