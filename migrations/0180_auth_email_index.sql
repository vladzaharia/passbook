-- The primary-email lookup matches lower(primary_email); without this it scans users on each Polaris ID sign-in.
CREATE INDEX users_primary_email_lower ON users (lower(primary_email));
-- Not UNIQUE: legacy case-variant duplicates would fail it. users_email_nc stays: the admin user search's prefix match relies on its NOCASE collation.
