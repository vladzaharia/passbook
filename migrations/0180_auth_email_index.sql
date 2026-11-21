-- The primary-email lookup matches lower(primary_email); without this it scans users on each Polaris ID sign-in.
CREATE INDEX users_primary_email_lower ON users (lower(primary_email));
