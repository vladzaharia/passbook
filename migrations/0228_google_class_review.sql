-- What Google's review says of a class, read back after a write and on later operations until approved.
-- NULL is unknown (not read yet, or the read failed). A rejected class is not offered. `review_status` is
-- cleared whenever the class body or generation moves. `verified_at` is the last time Google itself
-- confirmed the body (a created, compared or rewritten class), never a cache hit.
ALTER TABLE wallet_google_classes ADD COLUMN review_status TEXT
  CHECK(review_status IS NULL OR review_status IN ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'));
ALTER TABLE wallet_google_classes ADD COLUMN review_checked_at INTEGER;
ALTER TABLE wallet_google_classes ADD COLUMN verified_at INTEGER;
