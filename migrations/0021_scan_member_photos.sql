CREATE TABLE member_photos (
  pass_id TEXT PRIMARY KEY REFERENCES passes(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  sha1 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 1000000),
  crc32 INTEGER NOT NULL,
  include_in_pass INTEGER NOT NULL DEFAULT 0 CHECK(include_in_pass IN (0,1)),
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX member_photos_org ON member_photos(org_id);
CREATE INDEX member_photos_r2 ON member_photos(r2_key);
