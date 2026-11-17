import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import type { IdentityResolver } from '../identities/env-identity.ts';
import { createPassRow } from './create.ts';
import { depsOf, overrideDeps } from './deps.ts';
import { setupKit } from './pass-test-fixtures.ts';

const actor = { type: 'system', id: null } as const;

async function setup() {
  const kit = await setupKit();
  const live = kit.liveRelease;
  if (!live) throw new Error('Missing approved release');
  const create = (serial: string) =>
    createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: live.version,
      releaseId: live.id,
      releaseGeneration: live.generation,
      input: { memberName: 'Alex Morgan' },
      serial,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor,
    });
  return { kit, create };
}

describe('caller serials (L4)', () => {
  it('ignores the serial on the shared platform identity, so a repeat is no conflict', async () => {
    const { create } = await setup();
    const a = await create('squat-me');
    const b = await create('squat-me');
    expect(a.serial).not.toBe('squat-me');
    expect(b.serial).not.toBe('squat-me');
    expect(b.serial).not.toBe(a.serial);
  });

  it("honors the serial on the org's own identity and refuses a repeat", async () => {
    const { kit, create } = await setup();
    const ownId = crypto.randomUUID();
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at)
       VALUES (?, ?, 'Own', ?, 'TEAM', 'env', 'TEST', ?)`,
      [ownId, kit.org.id, `pass.test.${ownId}`, kit.clock.now()],
    );
    const base = depsOf(kit.env).identities;
    const asOwn = async () => ({ ...(await base.platform()), id: ownId, orgId: kit.org.id });
    const own: IdentityResolver = {
      ...base,
      forOrg: asOwn,
      byId: (id) => (id === ownId ? asOwn() : base.byId(id)),
    };
    overrideDeps(kit.env, { identities: own });
    const first = await create('mine-1');
    expect(first.serial).toBe('mine-1');
    const before = (await kit.env.BUCKET.list({ prefix: 'passes/' })).objects.length;
    await expect(create('mine-1')).rejects.toMatchObject({ code: 'SERIAL_TAKEN' });
    expect((await kit.env.BUCKET.list({ prefix: 'passes/' })).objects).toHaveLength(before);
  });
});
