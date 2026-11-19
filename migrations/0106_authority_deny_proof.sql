-- A written scan row and its retention proof disagree: the batch aborts as `authority_denied:proof`.
DROP TRIGGER authority_grants_deny;
CREATE TRIGGER authority_grants_deny BEFORE INSERT ON authority_grants WHEN NEW.denied IS NOT NULL
BEGIN SELECT CASE NEW.denied
  WHEN 'org' THEN RAISE(ABORT, 'authority_denied:org') WHEN 'actor' THEN RAISE(ABORT, 'authority_denied:actor')
  WHEN 'staff' THEN RAISE(ABORT, 'authority_denied:staff')
  WHEN 'config' THEN RAISE(ABORT, 'authority_denied:config') WHEN 'lineage' THEN RAISE(ABORT, 'authority_denied:lineage')
  WHEN 'stale' THEN RAISE(ABORT, 'authority_denied:stale') WHEN 'release' THEN RAISE(ABORT, 'authority_denied:release')
  WHEN 'retention' THEN RAISE(ABORT, 'authority_denied:retention') WHEN 'proof' THEN RAISE(ABORT, 'authority_denied:proof')
  ELSE RAISE(ABORT, 'authority_denied:other') END; END;
