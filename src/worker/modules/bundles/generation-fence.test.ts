import { expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { checksHold, jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { reassignHolder } from '../holders/service.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { bindBundle, bundleEmailSnapshot, matchesBundle } from './email-binding.ts';
import { assertBundleMember, bundleForToken } from './public-service.ts';
import { bundleChecks } from './repo-delivery-fence.ts';
import { currentBundleMembers } from './repo-public.ts';
import { createBundleGrant } from './repo-writes.ts';
import { createBundle } from './service.ts';

const actor = { type: 'system', id: null } as const;

function delayedBundle(kit: Kit, pass: Pass) {
  const id = kit.ctx.ids.id();
  return {
    id,
    grant: createBundleGrant(
      jobCtxOf(kit),
      {
        id,
        orgId: pass.orgId,
        mode: pass.mode,
        name: 'Delayed',
        token: kit.ctx.ids.token(),
        holderEmail: pass.holderEmail,
        actor,
        passes: [pass],
        now: kit.clock.now(),
      },
      undefined,
      {},
    ),
  };
}

it('binds the credential generation independently of the link, including membership and email', async () => {
  const kit = await setupKit();
  const pass = await kit.pass({ holderEmail: 'old-generation@example.test' });
  const bundle = await createBundle(
    jobCtxOf(kit),
    actor,
    'live',
    {
      orgId: kit.org.id,
      name: 'Family',
      passIds: [pass.id],
    },
    { kind: 'system' },
  );
  const snapshot = await bundleEmailSnapshot(kit.env.DB, bundle.id);
  if (!snapshot) throw new Error('Missing bundle snapshot');
  const oldChecks = bundleChecks(snapshot);
  const delayed = delayedBundle(kit, pass);
  const transfer = await reassignHolder(
    jobCtxOf(kit),
    actor,
    { passId: pass.id, email: 'new-generation@example.test' },
    null,
  );
  expect(transfer.transfer?.state).toBe('completed');
  expect(
    await checksHold(jobCtxOf(kit), { orgId: pass.orgId, mode: pass.mode, checks: oldChecks }),
  ).toBe(false);
  await expect(delayed.grant.commit()).rejects.toThrow();
  expect(await first(kit.env.DB, 'SELECT id FROM bundles WHERE id = ?', [delayed.id])).toBeNull();

  const current = await getPass(kit.env.DB, pass.id);
  if (!current) throw new Error('Missing transferred pass');
  expect(current.credentialGeneration).toBe(pass.credentialGeneration + 1);
  const replacement = await createBundle(
    jobCtxOf(kit),
    actor,
    'live',
    {
      orgId: kit.org.id,
      name: 'Family',
      passIds: [current.id],
    },
    { kind: 'system' },
  );
  const authorized = await bundleForToken(jobCtxOf(kit), replacement.url.split('/b/')[1] ?? '');
  const currentSnapshot = await bundleEmailSnapshot(kit.env.DB, replacement.id);
  if (!currentSnapshot?.passes[0]) throw new Error('Missing replacement snapshot');
  const intent = await bindBundle(currentSnapshot, 'holder@example.test');
  const member = intent.members[0];
  if (!member) throw new Error('Missing intent member');
  const stalePass = {
    ...currentSnapshot.passes[0],
    credentialGeneration: pass.credentialGeneration,
  };
  const staleIntent = {
    ...intent,
    members: [{ ...member, credentialGeneration: pass.credentialGeneration }],
  };
  const hold = (checks: ReturnType<typeof bundleChecks>) =>
    checksHold(jobCtxOf(kit), { orgId: pass.orgId, mode: pass.mode, checks });
  const staleInsert = delayedBundle(kit, stalePass);
  expect(await matchesBundle(currentSnapshot, intent)).toBe(true);
  expect(await matchesBundle(currentSnapshot, staleIntent)).toBe(false);
  expect(await hold(bundleChecks(currentSnapshot))).toBe(true);
  expect(await hold(bundleChecks({ ...currentSnapshot, passes: [stalePass] }))).toBe(false);
  expect(await currentBundleMembers(kit.env.DB, authorized, [currentSnapshot.passes[0]])).toBe(
    true,
  );
  expect(await currentBundleMembers(kit.env.DB, authorized, [stalePass])).toBe(false);
  await expect(assertBundleMember(jobCtxOf(kit), authorized, stalePass)).rejects.toMatchObject({
    status: 404,
  });
  await expect(staleInsert.grant.commit()).rejects.toThrow();
  expect(
    await first(kit.env.DB, 'SELECT id FROM bundles WHERE id = ?', [staleInsert.id]),
  ).toBeNull();
}, 120_000);

it('checks every member against the complete delivery authority in output SQL', async () => {
  const kit = await setupKit();
  const firstPass = await kit.pass();
  const secondPass = await kit.pass();
  const bundle = await createBundle(
    jobCtxOf(kit),
    actor,
    'live',
    {
      orgId: kit.org.id,
      name: 'Two members',
      passIds: [firstPass.id, secondPass.id],
    },
    { kind: 'system' },
  );
  const snapshot = await bundleEmailSnapshot(kit.env.DB, bundle.id);
  if (!snapshot) throw new Error('Missing bundle snapshot');
  const hold = (passes: Pass[]) =>
    checksHold(jobCtxOf(kit), {
      orgId: snapshot.bundle.org_id,
      mode: snapshot.bundle.mode,
      checks: bundleChecks({ ...snapshot, passes }),
    });
  expect(await hold(snapshot.passes)).toBe(true);
  expect(await currentBundleMembers(kit.env.DB, snapshot.bundle, snapshot.passes)).toBe(true);
  const authority: ((pass: Pass) => Pass)[] = [
    (pass) => ({ ...pass, identityId: `${pass.identityId}-stale` }),
    (pass) => ({ ...pass, credentialGeneration: pass.credentialGeneration + 1 }),
    (pass) => ({ ...pass, lifecycleGeneration: pass.lifecycleGeneration + 1 }),
    (pass) => ({ ...pass, templateId: `${pass.templateId}-stale` }),
  ];
  // Content moves without changing who may receive the pass: delivery no longer refuses on it
  // (authority-epochs.md F12/F14), though the public page read still binds the full member row.
  const content: ((pass: Pass) => Pass)[] = [
    (pass) => ({ ...pass, templateVersion: `${pass.templateVersion}-stale` }),
    (pass) => ({ ...pass, releaseId: pass.releaseId === null ? 'stale-release' : null }),
    (pass) => ({ ...pass, webServiceUrl: `${pass.webServiceUrl}/stale` }),
  ];
  for (const index of [0, 1]) {
    for (const [changes, holds] of [
      [authority, false],
      [content, true],
    ] as const) {
      for (const change of changes) {
        const passes = snapshot.passes.map((pass, position) =>
          position === index ? change(pass) : pass,
        );
        expect(await hold(passes)).toBe(holds);
        expect(await currentBundleMembers(kit.env.DB, snapshot.bundle, passes)).toBe(false);
      }
    }
  }
}, 120_000);
