import { certificateInfo } from '../../../passkit/sign/index.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { Logger } from '../../platform/log.ts';
import { envIdentityPresent, PLATFORM_IDENTITY_ID, readEnvIdentity } from './env-identity.ts';

/**
 * Upserts the env-sourced platform signing identity row (needed by passes.identity_id FK). Idempotent.
 * The pass type and team are written once, on insert: installed passes key on them, so a changed env
 * value is logged and nothing is written or signed. Once the default moved to a managed platform
 * identity the legacy row stops issuing and its env material may be removed: the row is kept and this
 * does nothing, so status and the daily check stop failing on `IDENTITY_NOT_CONFIGURED`.
 */
export async function ensurePlatformIdentity(env: AppEnv, now: number, log: Logger): Promise<void> {
  if (!envIdentityPresent(env)) {
    const retired = await first<{ issuing: number }>(
      env.DB,
      'SELECT issuing FROM signing_identities WHERE id = ?',
      [PLATFORM_IDENTITY_ID],
    );
    if (retired?.issuing === 0) return;
  }
  const identity = readEnvIdentity(env);
  const existing = await first<{ pass_type_identifier: string; team_identifier: string }>(
    env.DB,
    'SELECT pass_type_identifier, team_identifier FROM signing_identities WHERE id = ?',
    [PLATFORM_IDENTITY_ID],
  );
  if (
    existing &&
    (existing.pass_type_identifier !== identity.passTypeIdentifier ||
      existing.team_identifier !== identity.teamIdentifier)
  ) {
    log.error('identity.platform_env_mismatch', {
      code: 'IDENTITY_PLATFORM_ENV_MISMATCH',
      identityId: PLATFORM_IDENTITY_ID,
      rowPassType: existing.pass_type_identifier,
      envPassType: identity.passTypeIdentifier,
    });
    return;
  }
  const info = await certificateInfo(identity.material.certificate);
  const materialSha256 = await sha256Hex(
    JSON.stringify([identity.material.privateKey, identity.material.intermediate]),
  );
  await run(
    env.DB,
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, cert_pem, cert_sha256,
        not_before, not_after, apns_binding, env_material_sha256, is_default, created_at)
     VALUES (?, NULL, 'Platform', ?, ?, 'env', 'PLATFORM', ?, ?, ?, ?, ?, ?,
       NOT EXISTS (SELECT 1 FROM signing_identities WHERE is_default = 1), ?)
     ON CONFLICT (id) DO UPDATE SET
       cert_pem = excluded.cert_pem, cert_sha256 = excluded.cert_sha256,
       not_before = excluded.not_before, not_after = excluded.not_after, apns_binding = excluded.apns_binding,
       env_material_sha256 = excluded.env_material_sha256
     WHERE cert_sha256 IS NOT excluded.cert_sha256
       OR env_material_sha256 IS NOT excluded.env_material_sha256
       OR apns_binding IS NOT excluded.apns_binding
       OR not_before IS NOT excluded.not_before OR not_after IS NOT excluded.not_after
       OR cert_pem IS NOT excluded.cert_pem`,
    [
      PLATFORM_IDENTITY_ID,
      identity.passTypeIdentifier,
      identity.teamIdentifier,
      identity.material.certificate,
      info.sha256,
      info.notBefore.getTime(),
      info.notAfter.getTime(),
      identity.apnsBinding,
      materialSha256,
      now,
    ],
  );
}
