-- A custom group PassBook is about to create in Polaris ID. The row is written before the call, so a retry after a
-- failure between the call and the group's own row finds the group by its key and adopts it instead of orphaning it.
CREATE TABLE idp_group_intents (
  key TEXT PRIMARY KEY CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_]*' AND length(key) BETWEEN 2 AND 40),
  friendly_name TEXT NOT NULL CHECK (length(friendly_name) BETWEEN 2 AND 50),
  created_at INTEGER NOT NULL
);
