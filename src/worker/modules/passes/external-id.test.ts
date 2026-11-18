import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeTemplate } from '../../../../test/helpers/index.ts';
import { PassListSchema } from '../../../shared/contracts/index.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { inboxApp } from '../sandbox/test-tenant-fixtures.ts';
import { activeRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { createPassRow } from './create.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { externalIdFreeCheck } from './repo-external-id.ts';
import { getPass } from './repo-read-pass.ts';
import { updatePass } from './service.ts';

let kit: Kit;
let uniqueKit: Kit;
let otherOrgId: string;

async function setup(unique: boolean) {
  const k = await setupKit({
    template: (id) => {
      const t = makeTemplate({ id });
      if (unique) t.resolved.manifest.externalId = { unique: true };
      return t;
    },
  });
  return k;
}

async function create(k: Kit, externalId: string | null, orgId = k.org.id) {
  let release = await activeRelease(k.ctx, k.template.id, orgId, 'live', 'apple');
  if (!release) release = await approveAppleRelease(k, { orgId, mode: 'live' });
  return createPassRow(jobCtxOf({ ctx: k.ctx }), {
    orgId,
    templateId: k.template.id,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: 'Alex' },
    externalId,
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });
}

beforeAll(async () => {
  kit = await setup(false);
  uniqueKit = await setup(true);
  otherOrgId = (await makeOrg(kit.fx, { name: 'Other' })).id;
});

describe('GET /passes?externalId=', () => {
  it('matches exactly and stays inside the key organization', async () => {
    const mine = await create(kit, 'bk-1');
    await create(kit, 'bk-10');
    await create(kit, null);
    await create(kit, 'bk-1', otherOrgId);
    const app = inboxApp(kit);
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
    const list = async (query: string, headers = key.headers) =>
      app.request(`https://wallet.test/api/v1/passes?${query}`, { headers }, kit.env);
    const res = await list('externalId=bk-1');
    expect(res.status).toBe(200);
    const body = PassListSchema.parse(await res.json());
    expect(body.items.map((p) => p.id)).toEqual([mine.id]);
    expect(PassListSchema.parse(await (await list('externalId=bk')).json()).items).toEqual([]);
    // The other organization's key cannot reach this organization's passes by external id.
    const outsider = await makeApiKey(kit.fx, { orgId: otherOrgId, scopes: ['passes:read'] });
    const theirs = PassListSchema.parse(
      await (await list('externalId=bk-1', outsider.headers)).json(),
    );
    expect(theirs.items.map((p) => p.id)).not.toContain(mine.id);
    expect(theirs.items.every((p) => p.orgId === otherOrgId)).toBe(true);
    expect((await list(`orgId=${kit.org.id}&externalId=bk-1`, outsider.headers)).status).toBe(403);
  });
});

describe('per-template external id uniqueness', () => {
  it('allows duplicates when the template does not ask for it', async () => {
    await create(kit, 'dup-1');
    await expect(create(kit, 'dup-1')).resolves.toBeTruthy();
  });

  it('refuses a second pass with the same id when the template asks for it', async () => {
    await create(uniqueKit, 'u-1');
    const err = await create(uniqueKit, 'u-1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'EXTERNAL_ID_TAKEN', status: 409 });
    await expect(create(uniqueKit, 'u-2')).resolves.toBeTruthy();
    await expect(create(uniqueKit, null)).resolves.toBeTruthy();
    await expect(create(uniqueKit, null)).resolves.toBeTruthy();
  });

  it('enforces the rule on update, and lets a pass keep its own id', async () => {
    const a = await create(uniqueKit, 'up-1');
    await create(uniqueKit, 'up-2');
    const options = {
      scope: { orgId: uniqueKit.org.id, mode: 'live', principal: 'api_key' },
    } as const;
    const actor = { type: 'system', id: null } as const;
    const err = await updatePass(
      jobCtxOf({ ctx: uniqueKit.ctx }),
      actor,
      a.id,
      { externalId: 'up-2' },
      options,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'EXTERNAL_ID_TAKEN', status: 409 });
    await updatePass(
      jobCtxOf({ ctx: uniqueKit.ctx }),
      actor,
      a.id,
      { externalId: 'up-1' },
      options,
    );
    await updatePass(
      jobCtxOf({ ctx: uniqueKit.ctx }),
      actor,
      a.id,
      { externalId: 'up-3' },
      options,
    );
    expect((await getPass(uniqueKit.env.DB, a.id))?.externalId).toBe('up-3');
  });

  it('refuses inside the write when the id is taken after the pre-check', async () => {
    const mine = await create(uniqueKit, 'race-a');
    await create(uniqueKit, 'race-b');
    // The service pre-check is skipped here: only the write's own guard stands.
    const err = await publishPass(jobCtxOf({ ctx: uniqueKit.ctx }), {
      passId: mine.id,
      cause: 'api',
      actor: { type: 'system', id: null },
      mutate: () => ({ externalId: 'race-b' }),
      extraChecks: [externalIdFreeCheck(uniqueKit.template.id, 'race-b', mine.id)],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((await getPass(uniqueKit.env.DB, mine.id))?.externalId).toBe('race-a');
  });
});
