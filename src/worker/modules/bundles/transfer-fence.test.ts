import { describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { checksHold, jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { reassignHolder } from '../holders/service.ts';
import { finishCredentialTransfer } from '../passes/credential-transfer.ts';
import { overrideDeps } from '../passes/deps.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { expectValidZip, type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  newWalletClaimHandle,
} from '../wallet-providers/instance.ts';
import { reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import { finishWalletProviderRetirement } from '../wallet-providers/sync-operation-retirement.ts';
import { bundleEmailSnapshot } from './email-binding.ts';
import { bundleArchive, bundleForToken, bundleMembers, bundlePass } from './public-service.ts';
import { bundleChecks } from './repo-delivery-fence.ts';
import { currentBundleMembers } from './repo-public.ts';
import { createBundleGrant } from './repo-writes.ts';
import { createBundle } from './service.ts';

const actor = { type: 'system', id: null } as const;
const origin = 'https://wallet.test';
const tokenOf = (url: string) => url.split('/b/')[1] ?? '';

async function makeBundle(kit: Kit, passes: Pass[]) {
  return createBundle(
    jobCtxOf(kit),
    actor,
    'live',
    {
      orgId: kit.org.id,
      name: 'Family',
      passIds: passes.map((pass) => pass.id),
    },
    { kind: 'system' },
  );
}

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

const deferred = Promise;
// Storage lasts for the whole file; the credential keyset is immutable, so each case gets its own D1.
const makeEnv = installKeysetTestEnv();
const testDatabase = async () => (await makeEnv()).DB;

describe('bundle credential transfer fences', () => {
  it('removes old membership at START, fences pending, and permits unaffected and new bundles', async () => {
    const t = await setupSamsungCallbacks({
      holderEmail: 'bundle-old@example.test',
      db: await testDatabase(),
    });
    const { kit, pass } = t;
    const other = await kit.pass({ memberName: 'Unaffected bundle member' });
    const bundle = await makeBundle(kit, [other, pass]);
    const token = tokenOf(bundle.url);
    const authorized = await bundleForToken(jobCtxOf(kit), token);
    const snapshot = await bundleEmailSnapshot(kit.env.DB, bundle.id);
    if (!snapshot) throw new Error('Missing bundle snapshot');
    const holds = (s: typeof snapshot) =>
      checksHold(jobCtxOf(kit), {
        orgId: s.bundle.org_id,
        mode: s.bundle.mode,
        checks: bundleChecks(s),
      });
    const delayed = delayedBundle(kit, pass);
    const holder = await reassignHolder(
      jobCtxOf(kit),
      actor,
      { passId: pass.id, email: 'bundle-new@example.test' },
      null,
    );
    expect(holder.transfer?.state).toBe('pending');
    expect(
      await first(
        kit.env.DB,
        'SELECT pass_id FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?',
        [bundle.id, pass.id],
      ),
    ).toBeNull();
    expect(await holds(snapshot)).toBe(false);
    await expect(delayed.grant.commit()).rejects.toThrow();
    const pendingPass = await getPass(kit.env.DB, pass.id);
    if (!pendingPass) throw new Error('Missing pending pass');
    const pendingInsert = delayedBundle(kit, pendingPass);
    await expect(pendingInsert.grant.commit()).rejects.toThrow();
    expect(
      await first(kit.env.DB, 'SELECT id FROM bundles WHERE id = ?', [pendingInsert.id]),
    ).toBeNull();

    // A stray pre-existing membership cannot bypass the independent pending-transfer checks.
    await run(
      kit.env.DB,
      'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 1)',
      [bundle.id, pass.id],
    );
    expect(await currentBundleMembers(kit.env.DB, authorized, [pendingPass])).toBe(false);
    expect(await currentBundleMembers(kit.env.DB, authorized, [other, pendingPass])).toBe(false);
    const remaining = await bundleEmailSnapshot(kit.env.DB, bundle.id);
    if (!remaining) throw new Error('Missing unaffected member');
    expect(await holds(remaining)).toBe(true);
    expect(await holds({ bundle: authorized, passes: [pendingPass], positions: [1] })).toBe(false);
    expect(
      (await bundleMembers(jobCtxOf(kit), authorized)).map((member) => member.pass.id),
    ).toEqual([other.id]);
    await expect(bundlePass(jobCtxOf(kit), authorized, pass.id)).rejects.toMatchObject({
      status: 404,
    });
    await run(kit.env.DB, 'DELETE FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
      bundle.id,
      pass.id,
    ]);

    const app = createApp({ clock: kit.clock });
    const get = (path: string) => app.request(`${origin}${path}`, {}, kit.env);
    const page = await get(`/b/${token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`/b/${token}/${other.id}/pass.pkpass`);
    expect(html).not.toContain(`/b/${token}/${pass.id}/pass.pkpass`);
    expect((await get(`/b/${token}/${pass.id}/pass.pkpass`)).status).toBe(404);
    expect((await get(`/b/${token}/${pass.id}/assets/icon.png`)).status).toBe(404);
    expect((await get(`/b/${token}/${other.id}/pass.pkpass`)).status).toBe(200);
    const archive = await get(`/b/${token}/passes.pkpasses`);
    expect(archive.status).toBe(200);
    expect(expectValidZip(new Uint8Array(await archive.arrayBuffer()))).toEqual([
      `${other.id}.pkpass`,
    ]);

    const scope = {
      orgId: pass.orgId,
      mode: pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
    };
    const old = await getWalletInstanceById(kit.env.DB, scope);
    if (!old) throw new Error('Missing provider instance');
    expect(await reconcileWalletInstance(jobCtxOf(kit), old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(kit.env.DB, scope);
    if (!retiring) throw new Error('Missing retiring instance');
    const claim = {
      ...scope,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: kit.clock.now(),
    };
    expect(await claimWalletOperation(kit.env.DB, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(kit), {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(await finishWalletProviderRetirement(jobCtxOf(kit), claim)).toBe(true);
    if (!holder.transfer) throw new Error('Missing transfer');
    expect(await finishCredentialTransfer(jobCtxOf(kit), holder.transfer.transferId)).toMatchObject(
      {
        state: 'completed',
      },
    );
    const replacement = await getPass(kit.env.DB, pass.id);
    if (!replacement) throw new Error('Missing replacement pass');
    expect(replacement).toMatchObject({
      credentialGeneration: pass.credentialGeneration + 1,
      holderEmail: 'bundle-new@example.test',
    });
    expect((await get(`/b/${token}/${pass.id}/pass.pkpass`)).status).toBe(404);
    expect((await get(`/b/${token}/${pass.id}/assets/icon.png`)).status).toBe(404);
    expect((await get(`/b/${token}/${other.id}/pass.pkpass`)).status).toBe(200);
    const oldPage = await (await get(`/b/${token}`)).text();
    expect(oldPage).toContain(`/b/${token}/${other.id}/pass.pkpass`);
    expect(oldPage).not.toContain(`/b/${token}/${pass.id}/pass.pkpass`);
    const oldArchive = await get(`/b/${token}/passes.pkpasses`);
    expect(expectValidZip(new Uint8Array(await oldArchive.arrayBuffer()))).toEqual([
      `${other.id}.pkpass`,
    ]);
    const replacementBundle = await makeBundle(kit, [replacement]);
    const replacementToken = tokenOf(replacementBundle.url);
    expect((await get(`/b/${replacementToken}/${pass.id}/pass.pkpass`)).status).toBe(200);
    expect((await get(`/b/${replacementToken}/${pass.id}/assets/icon.png`)).status).toBe(200);
    const newArchive = await get(`/b/${replacementToken}/passes.pkpasses`);
    expect(expectValidZip(new Uint8Array(await newArchive.arrayBuffer()))).toEqual([
      `${pass.id}.pkpass`,
    ]);
  }, 120_000);

  it('aborts a multi-member archive if a later member transfers while its object opens', async () => {
    const kit = await setupKit({ db: await testDatabase() });
    const firstPass = await kit.pass();
    const secondPass = await kit.pass({ holderEmail: 'old-stream@example.test' });
    const bundle = await makeBundle(kit, [firstPass, secondPass]);
    const authorized = await bundleForToken(jobCtxOf(kit), tokenOf(bundle.url));
    const opened = deferred.withResolvers<void>();
    const resume = deferred.withResolvers<void>();
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key === secondPass.objectKey) {
        opened.resolve();
        await resume.promise;
      }
      return object;
    });
    try {
      const archive = await bundleArchive(jobCtxOf(kit), authorized);
      const reader = archive.body.getReader();
      expect((await reader.read()).done).toBe(false);
      expect((await reader.read()).done).toBe(false);
      const next = reader.read();
      await opened.promise;
      const holder = await reassignHolder(
        jobCtxOf(kit),
        actor,
        { passId: secondPass.id, email: 'new-stream@example.test' },
        null,
      );
      expect(holder.transfer?.state).toBe('completed');
      resume.resolve();
      await expect(next).rejects.toMatchObject({ status: 404 });
      expect(
        (await bundleMembers(jobCtxOf(kit), authorized)).map((member) => member.pass.id),
      ).toEqual([firstPass.id]);
    } finally {
      resume.resolve();
      spy.mockRestore();
    }
  }, 120_000);

  it('does not return a member file when transfer commits during the R2 open', async () => {
    const kit = await setupKit({ db: await testDatabase() });
    const pass = await kit.pass({ holderEmail: 'old-file@example.test' });
    const other = await kit.pass();
    const bundle = await makeBundle(kit, [pass, other]);
    const token = tokenOf(bundle.url);
    const app = createApp({ clock: kit.clock });
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let transferred = false;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key === pass.objectKey && !transferred) {
        transferred = true;
        const holder = await reassignHolder(
          jobCtxOf(kit),
          actor,
          { passId: pass.id, email: 'new-file@example.test' },
          null,
        );
        expect(holder.transfer?.state).toBe('completed');
      }
      return object;
    });
    try {
      const response = await app.request(
        `${origin}/b/${token}/${pass.id}/pass.pkpass`,
        {},
        kit.env,
      );
      expect(transferred).toBe(true);
      expect(response.status).toBe(404);
      const unaffected = await app.request(
        `${origin}/b/${token}/${other.id}/pass.pkpass`,
        {},
        kit.env,
      );
      expect(unaffected.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

  it('cannot expose a new holder photo when transfer wins just before the photo lookup', async () => {
    const kit = await setupKit({ db: await testDatabase() });
    const pass = await kit.pass({ holderEmail: 'old-photo@example.test' });
    const other = await kit.pass();
    const bundle = await makeBundle(kit, [pass, other]);
    const token = tokenOf(bundle.url);
    const png = makePng(270, 270);
    let changed = false;
    let opened = false;
    let photoKey = '';
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('FROM member_photos')) return statement;
            const wrap = (value: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(value, {
                get(inner, method) {
                  if (method === 'bind') return (...args: unknown[]) => wrap(inner.bind(...args));
                  if (method === 'first')
                    return async () => {
                      if (!changed) {
                        changed = true;
                        const holder = await reassignHolder(
                          jobCtxOf(kit),
                          actor,
                          { passId: pass.id, email: 'new-photo@example.test' },
                          null,
                        );
                        expect(holder.transfer?.state).toBe('completed');
                        await putMemberPhoto(
                          jobCtxOf(kit),
                          actor,
                          pass.id,
                          { png: btoa(String.fromCharCode(...png)), includeInPass: true },
                          null,
                        );
                        const photo = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
                        if (!photo) throw new Error('Missing new holder photo');
                        photoKey = photo.r2_key;
                      }
                      return inner.first();
                    };
                  const result = Reflect.get(inner, method, inner);
                  return typeof result === 'function' ? result.bind(inner) : result;
                },
              });
            return wrap(statement);
          };
        const result = Reflect.get(target, property, target);
        return typeof result === 'function' ? result.bind(target) : result;
      },
    });
    const env = { ...kit.env, DB: db };
    overrideDeps(env, { registry: kit.registry, apns: kit.apns, mailer: kit.mailer });
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key === photoKey) opened = true;
      return object;
    });
    const app = createApp({ clock: kit.clock });
    try {
      const response = await app.request(
        `${origin}/b/${token}/${pass.id}/assets/thumbnail@3x.png`,
        {},
        env,
      );
      expect(changed).toBe(true);
      expect(opened).toBe(true);
      expect(response.status).toBe(404);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(Array.from(bytes.subarray(0, 8))).not.toEqual(Array.from(png.subarray(0, 8)));
      const replacement = await getPass(kit.env.DB, pass.id);
      if (!replacement) throw new Error('Missing transferred pass');
      const next = await makeBundle(kit, [replacement]);
      const image = await app.request(
        `${origin}/b/${tokenOf(next.url)}/${pass.id}/assets/thumbnail@3x.png`,
        {},
        kit.env,
      );
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});
