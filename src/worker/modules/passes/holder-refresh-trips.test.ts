import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { devicePrincipal } from '../apple/repo-credential.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

describe('holder refresh round trips', () => {
  it('a device re-sign republishes in at most 7 round trips', async () => {
    const pass = await kit.pass();
    const original = kit.env.DB;
    const counted = countD1(original);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await publishPass(kit.ctx, {
        passId: pass.id,
        cause: 'user_refresh',
        actor: { type: 'system', id: null },
        holder: devicePrincipal(pass),
        force: true,
        dispatch: false,
        expectedPass: { version: pass.version, status: pass.status, objectKey: pass.objectKey },
      });
    } finally {
      Object.assign(kit.env, { DB: original });
    }
    const log = counted.tripLog();
    const heads = `\n${log.map((t) => `[${t.length}] ${t[0]?.replace(/\s+/g, ' ').slice(0, 40)}`).join('\n')}`;
    // 7 since the developer-org fence (builder.ts) reads the org kind once per build.
    expect(counted.count(), heads).toBeLessThanOrEqual(7);
  });
});
