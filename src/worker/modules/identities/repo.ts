import { certificateInfo } from '../../../passkit/sign/index.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { PLATFORM_IDENTITY_ID, readEnvIdentity } from './resolver.ts';

/** Upserts the env-sourced platform signing identity row (needed by passes.identity_id FK). Idempotent. */
export async function ensurePlatformIdentity(env: AppEnv, now: number): Promise<void> {
  const identity = readEnvIdentity(env);
  const info = await certificateInfo(identity.material.certificate);
  const existing = await first<{ cert_sha256: string | null }>(
    env.DB,
    'SELECT cert_sha256 FROM signing_identities WHERE id = ?',
    [PLATFORM_IDENTITY_ID],
  );
  if (existing?.cert_sha256 === info.sha256) return;
  await run(
    env.DB,
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, cert_pem, cert_sha256,
        not_before, not_after, apns_binding, is_default, created_at)
     VALUES (?, NULL, 'Platform', ?, ?, 'env', 'PLATFORM', ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (id) DO UPDATE SET
       pass_type_identifier = excluded.pass_type_identifier, team_identifier = excluded.team_identifier,
       cert_pem = excluded.cert_pem, cert_sha256 = excluded.cert_sha256,
       not_before = excluded.not_before, not_after = excluded.not_after, apns_binding = excluded.apns_binding`,
    [
      PLATFORM_IDENTITY_ID,
      identity.passTypeIdentifier,
      identity.teamIdentifier,
      identity.material.certificate,
      info.sha256,
      info.notBefore.getTime(),
      info.notAfter.getTime(),
      identity.apnsBinding,
      now,
    ],
  );
}
