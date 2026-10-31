CREATE TABLE passes (
  serial TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  pass_type TEXT NOT NULL,
  personalization TEXT NOT NULL,
  authentication_token TEXT NOT NULL,
  download_token TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  modified INTEGER NOT NULL,
  modified_collision INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  source_reference TEXT,
  source_version INTEGER NOT NULL DEFAULT 1,
  next_sync INTEGER NOT NULL DEFAULT 0,
  sync_error TEXT
);
CREATE TABLE changes (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL REFERENCES passes(serial) ON DELETE CASCADE
);
CREATE TABLE registrations (
  device TEXT NOT NULL,
  serial TEXT NOT NULL REFERENCES passes(serial) ON DELETE CASCADE,
  push_token TEXT NOT NULL,
  registered_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device, serial)
);
CREATE INDEX registrations_serial ON registrations(serial);
CREATE INDEX passes_sync ON passes(next_sync) WHERE source_id IS NOT NULL;
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('push','email')),
  serial TEXT NOT NULL REFERENCES passes(serial),
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  provider_id TEXT,
  error TEXT
);
CREATE INDEX outbox_due ON outbox(state, available_at);
CREATE TRIGGER pass_created AFTER INSERT ON passes BEGIN
  INSERT INTO changes(serial) VALUES (NEW.serial);
  UPDATE passes SET revision=last_insert_rowid() WHERE serial=NEW.serial;
END;
CREATE TRIGGER pass_updated AFTER UPDATE OF object_key ON passes WHEN NEW.object_key != OLD.object_key BEGIN
  INSERT INTO changes(serial) VALUES (NEW.serial);
  UPDATE passes SET revision=last_insert_rowid() WHERE serial=NEW.serial;
  INSERT INTO outbox(id,kind,serial) VALUES ('push:' || NEW.serial || ':' || NEW.version,'push',NEW.serial);
END;
