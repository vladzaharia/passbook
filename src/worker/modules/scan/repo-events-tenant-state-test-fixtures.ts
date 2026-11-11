import { all } from '../../platform/db.ts';
import { env } from './events-tenant-split-test-fixtures.ts';

export async function state() {
  return {
    events: await all(env.DB, 'SELECT * FROM scan_events ORDER BY id'),
    templates: await all(
      env.DB,
      'SELECT * FROM scan_event_templates ORDER BY event_id, template_id',
    ),
    scanners: await all(env.DB, 'SELECT * FROM scanners ORDER BY id'),
    scannerTemplates: await all(
      env.DB,
      'SELECT * FROM scanner_templates ORDER BY scanner_id, template_id',
    ),
    sessions: await all(env.DB, 'SELECT * FROM scanning_sessions ORDER BY id'),
    audits: await all(
      env.DB,
      "SELECT * FROM audit_log WHERE action LIKE 'scan_event.%' ORDER BY id",
    ),
    revisions: await all(
      env.DB,
      'SELECT * FROM scanning_config_revisions ORDER BY kind, target_id, revision',
    ),
  };
}
