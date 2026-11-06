CREATE TABLE pass_check_in (
  pass_id TEXT PRIMARY KEY REFERENCES passes(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rules TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(rules)),
  updated_at INTEGER NOT NULL
);
CREATE INDEX pass_check_in_org ON pass_check_in(org_id);
CREATE TABLE scan_presence (
  pass_id TEXT NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('in','out')),
  tracking INTEGER NOT NULL DEFAULT 0 CHECK(tracking IN (0,1)),
  entered_at INTEGER,
  first_at INTEGER NOT NULL,
  last_entry_at INTEGER NOT NULL,
  last_scan_id TEXT NOT NULL,
  prev_state TEXT,
  prev_tracking INTEGER,
  prev_entered_at INTEGER,
  prev_first_at INTEGER,
  prev_last_entry_at INTEGER,
  prev_scan_id TEXT,
  PRIMARY KEY(pass_id,scope)
);
CREATE INDEX scan_presence_org ON scan_presence(org_id,scope,state);
CREATE INDEX scans_admission ON scans(org_id,pass_id,event_id,at) WHERE outcome='ok' AND action_kind='check_in' AND undone_by IS NULL;
ALTER TABLE scans ADD COLUMN presence_scope TEXT;
INSERT INTO scan_presence(pass_id,org_id,scope,state,entered_at,first_at,last_entry_at,last_scan_id)
SELECT pass_id,org_id,place,state,CASE WHEN state='in' THEN last_at ELSE NULL END,first_seen,last_at,last_scan_id
FROM (
  SELECT *,MIN(first_at) OVER(PARTITION BY pass_id,place) AS first_seen,
    ROW_NUMBER() OVER(PARTITION BY pass_id,place ORDER BY last_at DESC,last_scan_id DESC) AS rank
  FROM (
    SELECT *,CASE WHEN scope LIKE 'event:%' THEN scope ELSE '' END AS place
    FROM scan_gates WHERE kind='check_in' AND state IN ('in','out')
  )
) WHERE rank=1;
