-- Prefix search over users and their verified emails (LIKE needs NOCASE indexes).
CREATE INDEX users_email_nc ON users (primary_email COLLATE NOCASE);
CREATE INDEX users_name_nc ON users (name COLLATE NOCASE);
CREATE INDEX user_emails_nc ON user_emails (email COLLATE NOCASE);
