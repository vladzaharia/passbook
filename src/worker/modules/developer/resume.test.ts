import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { first } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { NOOP } from '../operations/progress-types.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { mintSandboxKeyOnce } from './sandbox-key.ts';
import { provisionSandbox, type SandboxStep } from './service.ts';

/**
 * Provisioning is resumable: a request that dies after any step leaves a sandbox a retry by the same person
 * completes (membership, ticket, release, capture), never a 409. Provisioning mints no key: it is minted once
 * afterwards, and a second mint is a 409.
 */
let kit: BlueprintKit;
beforeAll(async () => {
  kit = await blueprintKit();
});

async function session(): Promise<{ auth: SessionAuth; userId: string }> {
  const user = await makeUser(kit.f);
  const made = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
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

const STEPS: SandboxStep[] = ['org', 'template', 'candidate', 'approval', 'release', 'capture'];
const provision = (auth: SessionAuth, step?: SandboxStep) =>
  provisionSandbox(ctx(), auth, NOOP, step ? { hooks: failAfter(step) } : {});

describe('a retry after a failure at each step', () => {
  it.each(STEPS)('completes what is missing after %s', async (step) => {
    const { auth, userId } = await session();
    await expect(provision(auth, step)).rejects.toBeInstanceOf(Injected);

    const retry = await provision(auth);
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
    expect(
      await count(
        "SELECT count(*) AS n FROM webhook_endpoints WHERE org_id = ? AND target = 'capture'",
        orgId,
      ),
    ).toBe(1);

    // No attempt made a key: it is minted once, afterwards, and never a second time.
    expect(
      await count(
        "SELECT count(*) AS n FROM api_keys WHERE org_id = ? AND kind = 'personal'",
        orgId,
      ),
    ).toBe(0);
    const key = await mintSandboxKeyOnce(ctx(), auth);
    expect(key.secret).toMatch(/^pbp_test_/);
    await expect(mintSandboxKeyOnce(ctx(), auth)).rejects.toMatchObject({
      code: 'SANDBOX_KEY_SHOWN',
    });
    // A further provision changes nothing.
    await provision(auth);
    expect(await count('SELECT count(*) AS n FROM api_keys WHERE org_id = ?', orgId)).toBe(1);
  });
});
