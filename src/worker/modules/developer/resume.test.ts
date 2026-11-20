import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { all, first } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { createSandbox, type SandboxStep } from './service.ts';

/**
 * Provisioning is resumable: a request that dies after any step leaves a sandbox a retry by the same person
 * completes (membership, ticket, release, key), never a 409. The key is minted once.
 */
let kit: BlueprintKit;
beforeAll(async () => {
  kit = await blueprintKit();
});

async function session(): Promise<{ auth: SessionAuth; userId: string }> {
  const user = await makeUser(kit.f);
  const made = await makeSession(kit.f, { userId: user.id });
  return {
    userId: user.id,
    auth: {
      kind: 'session',
      userId: user.id,
      sessionId: await sha256Hex(made.cookieValue),
      roles: ['user'],
      csrfSecret: made.csrf,
      amr: 'oidc',
      mode: 'live',
    },
  };
}

const ctx = () => createServiceContext(kit.env, { clock: kit.clock });
const count = async (sql: string, ...params: string[]) =>
  (await first<{ n: number }>(kit.env.DB, sql, params))?.n ?? 0;

class Injected extends Error {}
const failAfter = (step: SandboxStep) => ({
  after: async (s: SandboxStep) => {
    if (s === step) throw new Injected(`after ${step}`);
  },
});

const STEPS: SandboxStep[] = ['org', 'template', 'candidate', 'approval', 'release', 'key'];

describe('a retry after a failure at each step', () => {
  it.each(STEPS)('completes what is missing after %s', async (step) => {
    const { auth, userId } = await session();
    await expect(createSandbox(ctx(), auth, failAfter(step))).rejects.toBeInstanceOf(Injected);

    const retry = await createSandbox(ctx(), auth);
    const orgId = retry.orgId;
    expect(retry.previewOnly).toBe(true);
    expect(retry.templateId).not.toBeNull();

    // One sandbox, one org, one membership, one ticket with one Test release.
    expect(
      await count('SELECT count(*) AS n FROM developer_sandboxes WHERE user_id = ?', userId),
    ).toBe(1);
    expect(
      await count(
        'SELECT count(*) AS n FROM org_memberships WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL',
        orgId,
        userId,
      ),
    ).toBe(1);
    expect(await count('SELECT count(*) AS n FROM templates WHERE org_id = ?', orgId)).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM template_releases WHERE org_id = ? AND mode = 'test'",
        orgId,
      ),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM template_candidates WHERE org_id = ?', orgId),
    ).toBe(1);

    // The key exists exactly once. Where the first request died before minting it, the retry shows the secret;
    // where it died after (the response was lost), there is no secret and the key is named for "Roll key".
    const keys = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM api_keys WHERE org_id = ? AND kind = 'personal'",
      [orgId],
    );
    expect(keys).toHaveLength(1);
    if (step === 'key') {
      expect(retry.key).toBeNull();
      expect(retry.previousKey?.id).toBe(keys[0]?.id);
    } else {
      expect(retry.key?.secret).toMatch(/^pbp_test_/);
      expect(retry.key?.id).toBe(keys[0]?.id);
      expect(retry.previousKey).toBeNull();
    }

    // A further call changes nothing and never shows a second secret.
    const again = await createSandbox(ctx(), auth);
    expect(again.key).toBeNull();
    expect(again.previousKey?.id).toBe(keys[0]?.id);
    expect(await count('SELECT count(*) AS n FROM api_keys WHERE org_id = ?', orgId)).toBe(1);
  });
});
