CREATE TABLE scanning_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK(mode IN ('live','test')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','ended')),
  accepts TEXT CHECK(accepts IS NULL OR json_valid(accepts)),
  settings TEXT NOT NULL CHECK(json_valid(settings)),
  time_zone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(id,org_id)
);
CREATE INDEX scanning_sessions_creator ON scanning_sessions(created_by);
CREATE INDEX scanning_sessions_org ON scanning_sessions(org_id,mode,created_at);
CREATE UNIQUE INDEX scanners_session_scope ON scanners(id,org_id);
CREATE TABLE scanning_devices (
  scanner_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT 'auto' CHECK(surface IN ('auto','phone','operator','desk','customer')),
  effective_surface TEXT NOT NULL DEFAULT 'phone' CHECK(effective_surface IN ('phone','operator','desk','customer')),
  overrides TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(overrides)),
  capabilities TEXT CHECK(capabilities IS NULL OR json_valid(capabilities)),
  reported_at INTEGER,
  admin_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_key TEXT,
  FOREIGN KEY(session_id,org_id) REFERENCES scanning_sessions(id,org_id),
  FOREIGN KEY(scanner_id,org_id) REFERENCES scanners(id,org_id) ON DELETE CASCADE
);
CREATE INDEX scanning_devices_scanner_scope ON scanning_devices(scanner_id,org_id);
CREATE INDEX scanning_devices_admin_user ON scanning_devices(admin_user_id);
CREATE INDEX scanning_devices_session ON scanning_devices(session_id,org_id,mode);
CREATE TABLE scanning_config_revisions (
  kind TEXT NOT NULL CHECK(kind IN ('session','device')),
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(kind,target_id,revision)
);
CREATE UNIQUE INDEX scanning_devices_admin ON scanning_devices(session_id,admin_user_id,device_key)
  WHERE admin_user_id IS NOT NULL AND device_key IS NOT NULL;
DROP INDEX scanner_setups_owner;
CREATE INDEX scanner_setups_owner ON scanner_setups(org_id,mode,admin_user_id);

INSERT INTO scanning_sessions(id,org_id,mode,name,accepts,settings,time_zone,created_at,updated_at,created_by)
SELECT s.id,s.org_id,s.mode,s.name,
  CASE WHEN s.event_id IS NOT NULL THEN json_object('eventId',s.event_id)
    WHEN EXISTS(SELECT 1 FROM scanner_templates t WHERE t.scanner_id=s.id)
      THEN json_object('templateIds',json((SELECT json_group_array(template_id) FROM scanner_templates t WHERE t.scanner_id=s.id)))
    ELSE NULL END,
  s.settings,s.time_zone,s.created_at,s.updated_at,s.created_by FROM scanners s;
INSERT INTO scanning_devices(scanner_id,session_id,org_id,mode,surface,effective_surface,admin_user_id,device_key)
SELECT s.id,s.id,s.org_id,s.mode,
  CASE s.device_role WHEN 'customer' THEN 'customer' WHEN 'monitor' THEN 'desk' ELSE 'phone' END,
  CASE s.device_role WHEN 'customer' THEN 'customer' WHEN 'monitor' THEN 'desk' ELSE 'phone' END,
  m.admin_user_id,CASE WHEN m.admin_user_id IS NOT NULL THEN s.id ELSE NULL END
  FROM scanners s LEFT JOIN scanner_setups m ON m.scanner_id=s.id;
