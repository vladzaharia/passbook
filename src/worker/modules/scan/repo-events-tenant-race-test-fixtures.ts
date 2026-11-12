import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';

export function createEventTenantRaceQueries(getEnv: () => AppEnv) {
  async function seedScanningSessions(templateId: string, attachedId: string, freeId: string) {
    await run(
      getEnv().DB,
      `INSERT INTO scanning_sessions
        (id, org_id, mode, name, accepts, settings, time_zone, created_at, updated_at)
       SELECT id, org_id, mode, name,
         CASE WHEN event_id IS NULL THEN json_object('templateIds', json_array(?))
           ELSE json_object('eventId', event_id) END,
         settings, time_zone, created_at, updated_at FROM scanners WHERE id IN (?, ?)`,
      [templateId, attachedId, freeId],
    );
    await run(
      getEnv().DB,
      `INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode)
       SELECT id, id, org_id, mode FROM scanners WHERE id IN (?, ?)`,
      [attachedId, freeId],
    );
  }

  async function state() {
    return {
      events: await all(getEnv().DB, 'SELECT * FROM scan_events ORDER BY id'),
      templates: await all(
        getEnv().DB,
        'SELECT * FROM scan_event_templates ORDER BY event_id, template_id',
      ),
      scanners: await all(getEnv().DB, 'SELECT * FROM scanners ORDER BY id'),
      scannerTemplates: await all(
        getEnv().DB,
        'SELECT * FROM scanner_templates ORDER BY scanner_id, template_id',
      ),
      sessions: await all(getEnv().DB, 'SELECT * FROM scanning_sessions ORDER BY id'),
      revisions: await all(
        getEnv().DB,
        'SELECT * FROM scanning_config_revisions ORDER BY kind, target_id, revision',
      ),
      audits: await all(
        getEnv().DB,
        "SELECT * FROM audit_log WHERE action LIKE 'scan_event.%' ORDER BY id",
      ),
    };
  }

  /** Simulate a restored or externally corrupted singleton while keeping its guard intact afterward. */
  async function withMutableKeyset(work: () => Promise<void>) {
    const env = getEnv();
    const db = env.DB;
    await ensureCredentialRefKeyset(db, env);
    const original = await first<{ commitment: string }>(
      db,
      'SELECT commitment FROM credential_ref_keyset WHERE id=1',
    );
    const trigger = await first<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='credential_ref_keyset_no_update'",
    );
    if (!original || !trigger?.sql) throw new Error('Missing keyset fixture.');
    await run(db, 'DROP TRIGGER credential_ref_keyset_no_update');
    try {
      await work();
    } finally {
      try {
        await run(db, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
          original.commitment,
        ]);
      } finally {
        await run(db, trigger.sql);
      }
    }
  }

  async function withRemovableKeyset(work: () => Promise<void>) {
    const env = getEnv();
    const db = env.DB;
    const commitment = await ensureCredentialRefKeyset(db, env);
    const trigger = await first<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='credential_ref_keyset_no_delete'",
    );
    if (!trigger?.sql) throw new Error('Missing keyset delete guard.');
    await run(db, 'DROP TRIGGER credential_ref_keyset_no_delete');
    try {
      await work();
    } finally {
      try {
        await run(
          db,
          `INSERT INTO credential_ref_keyset (id,commitment)
          SELECT 1,? WHERE NOT EXISTS (SELECT 1 FROM credential_ref_keyset)`,
          [commitment],
        );
      } finally {
        await run(db, trigger.sql);
      }
    }
  }

  return { seedScanningSessions, state, withMutableKeyset, withRemovableKeyset };
}
