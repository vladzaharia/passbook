-- Existing captures have no immutable pass/bundle snapshot and therefore fail closed on read.
ALTER TABLE captured_emails ADD COLUMN intent TEXT
  CHECK (intent IS NULL OR json_valid(intent));
