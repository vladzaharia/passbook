-- What Google's review says of a class, read back after each write and on later operations until approved.
-- NULL is not read yet. A rejected class is not offered.
ALTER TABLE wallet_google_classes ADD COLUMN review_status TEXT
  CHECK(review_status IS NULL OR review_status IN ('DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'));
ALTER TABLE wallet_google_classes ADD COLUMN review_checked_at INTEGER;
