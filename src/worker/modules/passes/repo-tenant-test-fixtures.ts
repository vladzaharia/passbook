import {
  type ApiKeyFixture,
  type Fixtures,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
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
  // An org-less key stands for a platform key from before 0142: unbounded, past the insert rules.
  const platform = (options.orgId ?? null) === null;
  const insert = async () =>
    run(
      f.env.DB,
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, expires_at, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        platform ? 'platform' : 'service',
      ],
    );
  await (platform ? withoutTrigger(f.env.DB, 'api_keys_kind_rules', insert) : insert());
  return { id, secret, headers: { authorization: `Bearer ${secret}` } };
}
