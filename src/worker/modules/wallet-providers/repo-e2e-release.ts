import { run } from '../../platform/db.ts';

/** e2e only (e2e-release.ts): both providers in both modes to one release state, as a flip migration would. */
export async function setReleaseRows(
  db: D1Database,
  state: 'draining' | 'released',
  at: number,
): Promise<void> {
  await run(db, 'UPDATE wallet_provider_releases SET state = ?, changed_at = ?', [state, at]);
}
