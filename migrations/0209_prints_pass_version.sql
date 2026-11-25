-- What a print was made from. paper_hash is the sha256 of the ticket's drawn content (design, words, images; not the
-- code, number or time): a print is stale when the pass's current hash differs. pass_version is provenance only.
-- Null on prints made before these columns. Neither is a key column (pass_prints_key does not guard them); only a mint
-- sets them, and only a refresh (the active print drawn again: PDF, bulk, the page's Print) may update them.
ALTER TABLE pass_prints ADD COLUMN pass_version INTEGER
  CHECK (pass_version IS NULL OR (typeof(pass_version) = 'integer' AND pass_version >= 1));
ALTER TABLE pass_prints ADD COLUMN paper_hash TEXT
  CHECK (paper_hash IS NULL OR (typeof(paper_hash) = 'text' AND length(paper_hash) = 64 AND paper_hash NOT GLOB '*[^0-9a-f]*'));
