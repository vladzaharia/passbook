import type { ApiKeyFixture, Fixtures } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';

/** Create the key with its immutable authority already set. */
export async function makeTenantTestApiKey(
  f: Fixtures,
  options: {
    orgId?: string | null;
    scopes?: string[];
    name?: string;
    mode?: Mode;
    expiresAt?: number | null;
  } = {},
): Promise<ApiKeyFixture> {
  const id = f.ids.id();
  const prefix = f.ids.token(6);
  const secret = `wlt_${prefix}_${f.ids.token()}`;
  await run(
    f.env.DB,
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      options.orgId ?? null,
      options.name ?? 'Test key',
      prefix,
      await sha256Hex(secret),
      JSON.stringify(options.scopes ?? ['passes:read', 'passes:write']),
      options.mode ?? 'live',
      f.clock.now(),
      options.expiresAt ?? null,
    ],
  );
  return { id, secret, headers: { authorization: `Bearer ${secret}` } };
}
