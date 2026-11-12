ALTER TABLE passes ADD COLUMN test_data_quarantined INTEGER NOT NULL DEFAULT 0
  CHECK (test_data_quarantined IN (0, 1));

-- Existing Test passes have no trustworthy record of whether Live connector data was used.
UPDATE passes SET test_data_quarantined = 1 WHERE mode = 'test';
