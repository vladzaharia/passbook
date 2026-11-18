// What the minute cron `tokens.seal` of the pre-0070 Worker did to a migrated 0024 database: every plain
// token becomes a MAC with a sealed copy, and stored pass.json copies lose the device token. 0070 refuses to
// run until this is done, so the rehearsal does it between 0069 and 0070.
import { issueToken, sealStatement } from '../../src/worker/platform/capability-token.ts';
import { all } from '../../src/worker/platform/db.ts';
import { makeEnv } from '../helpers/index.ts';

export async function sealSeed(db: D1Database): Promise<void> {
  const env = await makeEnv({ DB: db });
  const statements: D1PreparedStatement[] = [];
  const passes = await all<{
    id: string;
    org_id: string;
    download_token: string;
    auth_token: string;
  }>(db, 'SELECT id, org_id, download_token, auth_token FROM passes');
  for (const p of passes) {
    const link = await issueToken(env, 'pass', p.id, p.org_id, p.download_token);
    const auth = await issueToken(env, 'apple-auth', p.id, p.org_id, p.auth_token);
    statements.push(
      db
        .prepare('UPDATE passes SET download_token = ?, auth_token = ? WHERE id = ?')
        .bind(link.mac, auth.mac, p.id),
      sealStatement(db, 'pass', p.id, link.mac, link.seal),
      sealStatement(db, 'apple-auth', p.id, auth.mac, auth.seal),
    );
  }
  const bundles = await all<{ id: string; org_id: string; token: string }>(
    db,
    'SELECT id, org_id, token FROM bundles',
  );
  for (const b of bundles) {
    const issued = await issueToken(env, 'bundle', b.id, b.org_id, b.token);
    statements.push(
      db.prepare('UPDATE bundles SET token = ? WHERE id = ?').bind(issued.mac, b.id),
      sealStatement(db, 'bundle', b.id, issued.mac, issued.seal),
    );
  }
  statements.push(
    db.prepare(
      `UPDATE pass_versions SET pass_json = json_remove(pass_json, '$.authenticationToken')
       WHERE CASE WHEN json_valid(pass_json) THEN json_type(pass_json, '$.authenticationToken') END IS NOT NULL`,
    ),
  );
  await db.batch(statements);
}
