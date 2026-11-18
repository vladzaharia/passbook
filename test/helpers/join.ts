import { issueToken } from '../../src/worker/platform/capability-token.ts';
import { run } from '../../src/worker/platform/db.ts';
import type { Fixtures } from './factories.ts';

export interface JoinLinkSeed {
  orgId: string;
  templateId: string;
  mode?: 'live' | 'test';
  enabled?: boolean;
  generation?: number;
  dailyLimit?: number;
}

/** A join link row with a sealed token, written raw (the admin write path is a later package). */
export async function makeJoinLink(f: Fixtures, seed: JoinLinkSeed) {
  const id = f.ids.id();
  const token = f.ids.token().slice(0, 22);
  const issued = await issueToken(f.env, 'join', id, seed.orgId, token);
  const now = f.clock.now();
  await run(
    f.env.DB,
    `INSERT INTO join_links (id, org_id, mode, template_id, token, generation, enabled, daily_limit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      seed.orgId,
      seed.mode ?? 'live',
      seed.templateId,
      issued.mac,
      seed.generation ?? 1,
      seed.enabled === false ? 0 : 1,
      seed.dailyLimit ?? (seed.mode === 'test' ? 50 : 200),
      now,
      now,
    ],
  );
  await run(
    f.env.DB,
    `INSERT INTO join_link_seals (link_id, org_id, kek_version, iv, wrapped_dek, ciphertext) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      seed.orgId,
      issued.seal.kekVersion,
      issued.seal.iv,
      issued.seal.wrappedDek,
      issued.seal.ciphertext,
    ],
  );
  return { id, token, mac: issued.mac, generation: seed.generation ?? 1 };
}
