import type { PassRow } from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import { noScopedReleaseSql } from '../templates/repo-releases.ts';

export function previewAuthorityQueries(env: AppEnv) {
  /** Give SQL-seeded passes the actual Wallet identity required by scanner reads. */
  async function seedWalletSnapshot(pass: PassRow, template: ResolvedTemplate): Promise<void> {
    const identity = await first<{ pass_type_identifier: string; team_identifier: string }>(
      env.DB,
      `SELECT si.pass_type_identifier, si.team_identifier FROM passes p
       JOIN signing_identities si ON si.id = p.identity_id WHERE p.id = ?`,
      [pass.id],
    );
    if (!identity) throw new Error('Missing pass signing identity');
    const snapshot = {
      ...template.passJson,
      serialNumber: pass.serial,
      passTypeIdentifier: identity.pass_type_identifier,
      teamIdentifier: identity.team_identifier,
      authenticationToken: pass.authToken,
    };
    await run(env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ? AND version = 1', [
      JSON.stringify(snapshot),
      pass.id,
    ]);
  }

  async function releaseState(passId: string) {
    const scope = {
      templateIdSql: 'p.template_id',
      orgIdSql: 'p.org_id',
      modeSql: 'p.mode',
      providerSql: "'apple'",
    };
    return first<{ absent: number; head: string | null }>(
      env.DB,
      `SELECT (${noScopedReleaseSql(scope)}) AS absent,
         (${effectiveReleaseIdSql(scope)}) AS head FROM passes p WHERE p.id = ?`,
      [passId],
    );
  }

  async function previewAudits(userId: string) {
    return all<{ org_id: string; target_id: string }>(
      env.DB,
      "SELECT org_id, target_id FROM audit_log WHERE action = 'scan_display.preview' AND actor_id = ? ORDER BY id",
      [userId],
    );
  }

  return { seedWalletSnapshot, releaseState, previewAudits };
}
