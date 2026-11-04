-- Sandbox: the test inbox and the indexes behind the daily purge of test data.
-- Independent of 0013, 0014 and 0016: wrangler may apply it after them.

-- Mail for test passes and bundles is rendered and kept here, never sent.
CREATE TABLE captured_emails (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  -- Exactly one of the two is set; a bundle email hangs on the bundle, a pass email on the pass.
  pass_id TEXT REFERENCES passes (id) ON DELETE CASCADE,
  bundle_id TEXT REFERENCES bundles (id) ON DELETE CASCADE,
  outbox_id TEXT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  attached INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX captured_emails_org ON captured_emails (org_id, created_at DESC, id DESC);
CREATE INDEX captured_emails_pass ON captured_emails (pass_id) WHERE pass_id IS NOT NULL;
CREATE INDEX captured_emails_bundle ON captured_emails (bundle_id) WHERE bundle_id IS NOT NULL;
CREATE INDEX captured_emails_age ON captured_emails (created_at);
-- A re-run of the same outbox row captures once.
CREATE UNIQUE INDEX captured_emails_outbox ON captured_emails (outbox_id) WHERE outbox_id IS NOT NULL;

-- The purge walks test data by age; live rows never enter these indexes.
CREATE INDEX passes_test_age ON passes (created_at) WHERE mode = 'test';
CREATE INDEX bundles_test_age ON bundles (created_at) WHERE mode = 'test';
