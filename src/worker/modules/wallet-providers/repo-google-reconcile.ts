import { all, run } from '../../platform/db.ts';

/**
 * One active instance for each Google class that an earlier release of the template still holds and the
 * given release has not written, on passes already at the release's template version. Rewriting a class
 * needs a compile of one pass of it, so one representative is enough.
 */
export function listStaleGoogleClassInstances(
  db: D1Database,
  p: {
    orgId: string;
    mode: 'live' | 'test';
    templateId: string;
    version: string;
    generation: number;
  },
  limit: number,
): Promise<{ instanceId: string }[]> {
  return all(
    db,
    `SELECT MIN(i.id) AS instanceId
    FROM wallet_google_callback_bindings b
    JOIN wallet_provider_instances i ON i.id = b.instance_id AND i.provider = 'google'
      AND i.lifecycle = 'active' AND i.retirement_requested_at IS NULL AND i.org_id = ? AND i.mode = ?
    JOIN template_releases r ON r.id = i.identity_projection_release_id AND r.template_id = ? AND r.generation < ?
    JOIN passes pass ON pass.id = i.pass_id AND pass.org_id = i.org_id AND pass.mode = i.mode
      AND pass.template_id = r.template_id AND pass.template_version = ?
    LEFT JOIN wallet_google_classes c ON c.class_id_hash = b.class_id_hash
    WHERE c.class_id_hash IS NULL OR c.release_generation < ?
    GROUP BY b.class_id_hash ORDER BY b.class_id_hash LIMIT ?`,
    [p.orgId, p.mode, p.templateId, p.generation, p.version, p.generation, limit],
  );
}

export async function markInstanceDirty(db: D1Database, instanceId: string): Promise<void> {
  await run(
    db,
    `INSERT INTO wallet_provider_instance_dirty(instance_id, generation) VALUES (?, 1)
    ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1, next_attempt_at = 0`,
    [instanceId],
  );
}
