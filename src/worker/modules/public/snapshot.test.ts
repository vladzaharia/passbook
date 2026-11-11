import { unzlibSync, zlibSync } from 'fflate';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { isolatedKeysetDatabase } from '../../../../test/helpers/credential-keyset.ts';
import { fakeAuth, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { crc32 } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { putPassAsset } from '../passes/asset-service.ts';
import {
  type CredentialTransferResult,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { overrideDeps } from '../passes/deps.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG, type Kit, setupKit, TINY_PNG } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { setupWalletOfferKit } from '../wallet-providers/offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from '../wallet-providers/provider-policy.ts';
import { presentationForPass } from './presentation.ts';
import { getPassAsset } from './repo.ts';
import { passForToken, passImages } from './service.ts';
import { assertPassSnapshot, capturePassSnapshot } from './snapshot.ts';

const ORIGIN = 'https://wallet.test';
const actor = { type: 'system', id: null } as const;
const oldPhoto = makePng(270, 270);
const auth = fakeAuth(ORIGIN);
const app = createApp({ stores: auth.stores });
// The worker targets ES2023; its test runtime provides Promise.withResolvers.
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};
let kit: Kit;

beforeAll(async () => {
  kit = await setupKit();
});

const get = (path: string, headers: Record<string, string> = {}, env = kit.env) =>
  app.request(`${ORIGIN}${path}`, { headers }, env);
const assetPath = (token: string) => `/p/${token}/assets/thumbnail@3x.png`;

const testPass = (orgId = kit.org.id) => kit.pass({ orgId, mode: 'test' });

async function photoPass(orgId?: string, testMode = false) {
  const owner = await makeUser(kit.fx);
  const pass = await kit.pass({
    ...(orgId ? { orgId } : {}),
    mode: testMode ? 'test' : 'live',
    holderEmail: owner.primaryEmail,
  });
  await putMemberPhoto(
    jobCtxOf(kit),
    actor,
    pass.id,
    { png: btoa(String.fromCharCode(...oldPhoto)), includeInPass: true },
    null,
  );
  const current = await getPass(kit.env.DB, pass.id);
  const photo = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
  if (!current || !photo) throw new Error('Photo pass fixture was not stored');
  return { pass: current, photo, owner };
}

/** Return another valid 270px PNG with a visibly different first pixel. */
function newHolderPhoto(): Uint8Array {
  const length = new DataView(oldPhoto.buffer, oldPhoto.byteOffset, oldPhoto.byteLength).getUint32(
    33,
  );
  const pixels = unzlibSync(oldPhoto.subarray(41, 41 + length));
  pixels[1] = 255;
  pixels[4] = 255;
  const compressed = zlibSync(pixels);
  const chunk = new Uint8Array(compressed.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, compressed.length);
  chunk.set([73, 68, 65, 84], 4); // IDAT
  chunk.set(compressed, 8);
  view.setUint32(8 + compressed.length, crc32(chunk.subarray(4, 8 + compressed.length)));
  const png = new Uint8Array(33 + chunk.length + oldPhoto.length - (45 + length));
  png.set(oldPhoto.subarray(0, 33));
  png.set(chunk, 33);
  png.set(oldPhoto.subarray(45 + length), 33 + chunk.length);
  return png;
}

/** Keep a real R2 body, while observing cancellation even through a Response wrapper. */
function observeCancellation(object: R2ObjectBody, onCancel: () => void): R2ObjectBody {
  const reader = object.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      async cancel(reason) {
        onCancel();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Proxy(object, {
    get(target, property) {
      if (property === 'body') return body;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Perform a write immediately before one selected D1 read; all SQL still runs against real D1. */
function beforeFirstRead(
  db: D1Database,
  matches: (sql: string) => boolean,
  change: () => Promise<void>,
) {
  let fired = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === 'first')
          return async () => {
            if (!fired) {
              fired = true;
              await change();
            }
            return target.first();
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return matches(sql) ? wrap(statement) : statement;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function expectNoImage(response: Response, code = 'PASS_NOT_FOUND') {
  expect(response.status).toBe(404);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(Array.from(bytes.subarray(0, 8))).not.toEqual(Array.from(oldPhoto.subarray(0, 8)));
  expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ code });
}

async function startTransfer(
  pass: Pass,
  target?: { id: string; primaryEmail: string },
  fixture = kit,
) {
  const expected = await getHolderPass(fixture.env.DB, pass.id, null);
  if (!expected) throw new Error('Missing holder transfer snapshot');
  return startCredentialTransfer(
    jobCtxOf(fixture),
    actor,
    pass.id,
    { holderEmail: target?.primaryEmail ?? 'next@example.test', ownerUserId: target?.id ?? null },
    null,
    { kind: 'tenant-holder', expected },
  );
}

async function expectNoDisclosure(response: Response, secrets: string[]) {
  expect(response.status).toBe(404);
  const body = await response.text();
  for (const secret of secrets) {
    expect(body).not.toContain(secret);
    response.headers.forEach((value) => {
      expect(value).not.toContain(secret);
    });
  }
}

describe('public pass snapshots', () => {
  it('accepts an unchanged snapshot and refuses to capture an already stale pass', async () => {
    const pass = await kit.pass();
    const snapshot = await capturePassSnapshot(kit.ctx, pass);
    await expect(assertPassSnapshot(kit.ctx, snapshot)).resolves.toBeUndefined();
    await run(kit.env.DB, 'UPDATE passes SET download_token = ? WHERE id = ?', [
      kit.fx.ids.token(),
      pass.id,
    ]);
    await expect(capturePassSnapshot(kit.ctx, pass)).rejects.toMatchObject({
      status: 404,
      code: 'PASS_NOT_FOUND',
    });
  });

  it.each([
    {
      name: 'token',
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET download_token = ? WHERE id = ?', [
          kit.fx.ids.token(),
          pass.id,
        ]),
    },
    {
      name: 'link generation, even when the token is unchanged',
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
          pass.id,
        ]),
    },
    {
      name: 'holder transfer',
      change: async (pass: Pass) => {
        const owner = await makeUser(kit.fx);
        return startTransfer(pass, owner);
      },
    },
    {
      name: 'version',
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]),
    },
    {
      name: 'revision',
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [pass.id]),
    },
    {
      name: 'artifact key',
      change: async (pass: Pass) => {
        // Publishing creates a version row and revision. Restore those two fields to isolate the key.
        await run(
          kit.env.DB,
          'UPDATE passes SET object_key = ?, version = version + 1 WHERE id = ?',
          [`${pass.objectKey}.replacement`, pass.id],
        );
        return run(kit.env.DB, 'UPDATE passes SET version = ?, revision = ? WHERE id = ?', [
          pass.version,
          pass.revision,
          pass.id,
        ]);
      },
    },
    {
      name: 'status',
      change: (pass: Pass) =>
        run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]),
    },
    {
      name: 'Wallet removal',
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
          kit.clock.now(),
          pass.id,
        ]),
    },
    {
      name: 'soft deletion',
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
          kit.clock.now(),
          pass.id,
        ]),
    },
    {
      name: 'a stale captured scan code',
      change: async (pass: Pass) => {
        pass.scanCode = null;
      },
    },
  ])(
    'rejects a snapshot after a change to $name',
    async ({ change }) => {
      const pass = await kit.pass();
      const snapshot = await capturePassSnapshot(kit.ctx, pass);
      await change(pass);
      await expect(assertPassSnapshot(kit.ctx, snapshot)).rejects.toMatchObject({
        status: 404,
        code: 'PASS_NOT_FOUND',
      });
      await expect(capturePassSnapshot(kit.ctx, pass)).rejects.toMatchObject({
        status: 404,
        code: 'PASS_NOT_FOUND',
      });
    },
    120_000,
  );

  it('invalidates a test pass snapshot if quarantine starts after capture', async () => {
    const pass = await testPass();
    const snapshot = await capturePassSnapshot(kit.ctx, pass);
    await expect(assertPassSnapshot(kit.ctx, snapshot)).resolves.toBeUndefined();
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    await expect(assertPassSnapshot(kit.ctx, snapshot)).rejects.toMatchObject({
      status: 404,
      code: 'PASS_NOT_FOUND',
    });
    await expect(capturePassSnapshot(kit.ctx, pass)).rejects.toMatchObject({ status: 404 });
  });

  it('invalidates a captured snapshot when its organization is suspended', async () => {
    const org = await makeOrg(kit.fx);
    const pass = await kit.pass({ orgId: org.id });
    const snapshot = await capturePassSnapshot(kit.ctx, pass);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    await expect(assertPassSnapshot(kit.ctx, snapshot)).rejects.toMatchObject({
      status: 404,
      code: 'PASS_NOT_FOUND',
    });
    await expect(capturePassSnapshot(kit.ctx, pass)).rejects.toMatchObject({ status: 404 });
  });
});

describe('public credential transfer fence', () => {
  it('withholds both bearer and owner surfaces while pending, then serves only the new holder', async () => {
    const oldOwner = await makeUser(kit.fx);
    const nextOwner = await makeUser(kit.fx);
    const holderName = 'Transfer Holder Private Foxtrot';
    const pass = await kit.pass({ memberName: holderName, holderEmail: oldOwner.primaryEmail });
    expect(pass.ownerUserId).toBe(oldOwner.id);
    const snapshot = await capturePassSnapshot(kit.ctx, pass);
    const oldOwnerHeaders = auth.user(oldOwner.id);
    const nextOwnerHeaders = auth.user(nextOwner.id);
    const oldBase = `/p/${pass.downloadToken}`;
    const oldFile = await get(`${oldBase}/pass.pkpass`);
    expect(oldFile.status).toBe(200);
    const fileEtag = oldFile.headers.get('etag') ?? '*';
    const oldBytes = new Uint8Array(await oldFile.arrayBuffer());
    const oldIcon = await get(`${oldBase}/assets/icon.png`);
    expect(oldIcon.status).toBe(200);
    const iconEtag = oldIcon.headers.get('etag') ?? '*';
    await oldIcon.arrayBuffer();
    expect((await get(`${oldBase}/barcode`)).status).toBe(200);
    expect((await get(`/api/v1/me/passes/${pass.id}/barcode`, oldOwnerHeaders)).status).toBe(200);

    const entered = deferred.withResolvers<void>();
    const held = deferred.withResolvers<void>();
    const originalPut = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
      if (key.startsWith(`passes/${pass.id}/`)) {
        entered.resolve();
        await held.promise;
      }
      return originalPut(key, value, options);
    });
    const running = startTransfer(pass, nextOwner);
    let outcome: CredentialTransferResult | undefined;
    let pendingToken = '';
    try {
      await Promise.race([
        entered.promise,
        running.then((result) => {
          throw new Error(`Transfer finished before the R2 gate: ${result.state}`);
        }),
      ]);
      const pending = await getPass(kit.env.DB, pass.id);
      if (!pending) throw new Error('Missing pending pass');
      pendingToken = pending.downloadToken;
      expect(pendingToken).not.toBe(pass.downloadToken);
      expect(pending.credentialGeneration).toBe(pass.credentialGeneration + 1);
      expect(pending.linkGeneration).toBe(pass.linkGeneration + 1);
      expect(pending.ownerUserId).toBe(oldOwner.id);
      expect(
        await first(
          kit.env.DB,
          `SELECT state, source_generation, target_generation
        FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'`,
          [pass.id],
        ),
      ).toEqual({
        state: 'pending',
        source_generation: pass.credentialGeneration,
        target_generation: pending.credentialGeneration,
      });
      await expect(passForToken(kit.ctx, pass.downloadToken)).rejects.toMatchObject({
        status: 404,
      });
      await expect(passForToken(kit.ctx, pendingToken)).rejects.toMatchObject({ status: 404 });
      await expect(assertPassSnapshot(kit.ctx, snapshot)).rejects.toMatchObject({ status: 404 });
      await expect(capturePassSnapshot(kit.ctx, pending)).rejects.toMatchObject({ status: 404 });
      await expect(passImages(kit.ctx, pending)).rejects.toMatchObject({ status: 404 });
      await expect(presentationForPass(kit.ctx, pending)).rejects.toMatchObject({ status: 404 });

      const secrets = [
        holderName,
        oldOwner.primaryEmail,
        pass.downloadToken,
        pendingToken,
        pass.authToken,
        pass.scanCode,
      ].filter((value): value is string => Boolean(value));
      for (const token of [pass.downloadToken, pendingToken]) {
        const base = `/p/${token}`;
        for (const [path, headers] of [
          [base, {}],
          [`${base}/barcode`, {}],
          [`${base}/pass.pkpass`, {}],
          [`${base}/pass.pkpass`, { 'if-none-match': fileEtag }],
          [`${base}/assets/icon.png`, {}],
          [`${base}/assets/icon.png`, { 'if-none-match': iconEtag }],
        ] as [string, Record<string, string>][]) {
          await expectNoDisclosure(await get(path, headers), secrets);
        }
      }
      await expectNoDisclosure(
        await get(`/api/v1/me/passes/${pass.id}/barcode`, oldOwnerHeaders),
        secrets,
      );
      await expectNoDisclosure(
        await get(`/api/v1/me/passes/${pass.id}/barcode`, nextOwnerHeaders),
        secrets,
      );
      for (const path of [`/api/v1/me/passes/${pass.id}`, '/api/v1/me/passes']) {
        const response = await get(path, oldOwnerHeaders);
        const text = await response.text();
        for (const secret of secrets) expect(text).not.toContain(secret);
      }
    } finally {
      held.resolve();
      spy.mockRestore();
      outcome = await running;
    }

    expect(outcome?.state).toBe('completed');
    const fresh = await getPass(kit.env.DB, pass.id);
    if (!fresh) throw new Error('Missing completed pass');
    expect(fresh.downloadToken).toBe(pendingToken);
    expect(fresh.ownerUserId).toBe(nextOwner.id);
    expect(fresh.serial).not.toBe(pass.serial);
    expect(fresh.scanCode).not.toBe(pass.scanCode);
    // START really advanced the persisted generation. Isolate that dimension from the other
    // transfer changes by holding the fresh row's token, owner and artifact fixed.
    expect(fresh.credentialGeneration).toBe(pass.credentialGeneration + 1);
    const staleCredential = { ...fresh, credentialGeneration: pass.credentialGeneration };
    await expect(capturePassSnapshot(kit.ctx, staleCredential)).rejects.toMatchObject({
      status: 404,
    });
    const freshSnapshot = await capturePassSnapshot(kit.ctx, fresh);
    await expect(
      assertPassSnapshot(kit.ctx, {
        ...freshSnapshot,
        credentialGeneration: pass.credentialGeneration,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(capturePassSnapshot(kit.ctx, pass)).rejects.toMatchObject({ status: 404 });
    await expect(passImages(kit.ctx, pass)).rejects.toMatchObject({ status: 404 });
    await expect(presentationForPass(kit.ctx, pass)).rejects.toMatchObject({ status: 404 });
    expect((await presentationForPass(kit.ctx, fresh)).barcode?.message).toBe(fresh.scanCode);
    expect((await passForToken(kit.ctx, fresh.downloadToken)).id).toBe(pass.id);
    const images = await passImages(kit.ctx, fresh);
    expect(images.length).toBeGreaterThan(0);
    expect(
      images.every((image) => image.path.startsWith(`/p/${fresh.downloadToken}/assets/`)),
    ).toBe(true);
    expect((await get(oldBase)).status).toBe(404);
    const freshPage = await get(`/p/${fresh.downloadToken}`);
    expect(freshPage.status).toBe(200);
    expect(await freshPage.text()).toContain(`/p/${fresh.downloadToken}/pass.pkpass`);
    expect((await get(`/p/${fresh.downloadToken}/barcode`)).status).toBe(200);
    const freshFile = await get(`/p/${fresh.downloadToken}/pass.pkpass`);
    expect(freshFile.status).toBe(200);
    expect(new Uint8Array(await freshFile.arrayBuffer())).not.toEqual(oldBytes);
    expect((await get(`/api/v1/me/passes/${pass.id}/barcode`, oldOwnerHeaders)).status).toBe(404);
    expect((await get(`/api/v1/me/passes/${pass.id}/barcode`, nextOwnerHeaders)).status).toBe(200);
    const freshOwner = await get(`/api/v1/me/passes/${pass.id}`, nextOwnerHeaders);
    expect(freshOwner.status).toBe(200);
    expect(await freshOwner.text()).toContain(fresh.downloadToken);
  }, 120_000);

  it('does not resolve a bearer whose transfer commits after the token lookup', async () => {
    const pass = await kit.pass();
    const change = vi.fn(async () => {
      expect((await startTransfer(pass)).state).toBe('completed');
    });
    const env: AppEnv = {
      ...kit.env,
      DB: beforeFirstRead(
        kit.env.DB,
        (sql) => sql.includes('SELECT p.link_generation, p.credential_generation FROM passes p'),
        change,
      ),
    };
    await expect(passForToken({ ...kit.ctx, env }, pass.downloadToken)).rejects.toMatchObject({
      status: 404,
      code: 'LINK_NOT_FOUND',
    });
    expect(change).toHaveBeenCalledOnce();
    const fresh = await getPass(kit.env.DB, pass.id);
    if (!fresh) throw new Error('Missing completed pass');
    expect((await passForToken(kit.ctx, fresh.downloadToken)).id).toBe(pass.id);
  }, 120_000);

  it.each(['page', 'barcode'] as const)(
    'rejects a stale %s when the transfer completes during the stored JSON read',
    async (surface) => {
      const pass = await kit.pass({ memberName: 'Raced Holder Private Golf' });
      const change = vi.fn(async () => {
        expect((await startTransfer(pass)).state).toBe('completed');
      });
      const env: AppEnv = {
        ...kit.env,
        DB: beforeFirstRead(kit.env.DB, (sql) => sql.includes('FROM pass_versions'), change),
      };
      overrideDeps(env, { registry: kit.registry, apns: kit.apns, mailer: kit.mailer });
      const suffix = surface === 'barcode' ? '/barcode' : '';
      const response = await get(`/p/${pass.downloadToken}${suffix}`, {}, env);
      expect(change).toHaveBeenCalledOnce();
      const fresh = await getPass(kit.env.DB, pass.id);
      if (!fresh) throw new Error('Missing completed pass');
      await expectNoDisclosure(response, [
        pass.downloadToken,
        fresh.downloadToken,
        'Raced Holder Private Golf',
      ]);
      expect((await get(`/p/${fresh.downloadToken}${suffix}`)).status).toBe(200);
    },
    120_000,
  );

  it.each(['pass.pkpass', 'assets/icon.png'] as const)(
    'cancels a %s stream when a transfer starts after R2 open',
    async (surface) => {
      const created = await kit.pass();
      await putPassAsset(jobCtxOf(kit), actor, created.id, 'icon.png', ICON_PNG, null);
      const pass = await getPass(kit.env.DB, created.id);
      const icon = await getPassAsset(kit.env.DB, created.id, 'icon.png');
      if (!pass || !icon) throw new Error('Missing pass or icon fixture');
      const key = surface === 'pass.pkpass' ? pass.objectKey : icon.r2Key;
      const entered = deferred.withResolvers<void>();
      const held = deferred.withResolvers<void>();
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      const originalPut = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      let running: Promise<CredentialTransferResult> | undefined;
      const putSpy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (objectKey, value, options) => {
          if (objectKey.startsWith(`passes/${pass.id}/`)) {
            entered.resolve();
            await held.promise;
          }
          return originalPut(objectKey, value, options);
        });
      const getSpy = vi
        .spyOn(kit.env.BUCKET, 'get')
        .mockImplementation(async (objectKey, options) => {
          const object = await originalGet(objectKey, options);
          if (objectKey !== key || !object || opened) return object;
          opened = true;
          running = startTransfer(pass);
          await Promise.race([
            entered.promise,
            running.then((result) => {
              throw new Error(`Transfer finished before the R2 gate: ${result.state}`);
            }),
          ]);
          return observeCancellation(object, () => cancelled++);
        });
      let outcome: CredentialTransferResult | undefined;
      try {
        const response = await get(`/p/${pass.downloadToken}/${surface}`);
        const pending = await getPass(kit.env.DB, pass.id);
        if (!pending) throw new Error('Missing pending pass');
        expect(
          await first(
            kit.env.DB,
            `SELECT state FROM pass_credential_transfers
          WHERE pass_id = ? AND state = 'pending'`,
            [pass.id],
          ),
        ).toEqual({ state: 'pending' });
        expect(opened).toBe(true);
        expect(cancelled).toBe(1);
        await expectNoDisclosure(response, [
          pass.downloadToken,
          pending.downloadToken,
          pass.authToken,
        ]);
      } finally {
        held.resolve();
        getSpy.mockRestore();
        putSpy.mockRestore();
        if (running !== undefined) outcome = await running;
      }
      expect(outcome?.state).toBe('completed');
      const fresh = await getPass(kit.env.DB, pass.id);
      if (!fresh) throw new Error('Missing completed pass');
      const current = await get(`/p/${fresh.downloadToken}/${surface}`);
      expect(current.status).toBe(200);
      await current.arrayBuffer();
    },
    120_000,
  );
});

describe('public asset fencing', () => {
  it('serves the unchanged photo and template icon privately, including conditional responses', async () => {
    const { pass, photo } = await photoPass();
    const image = await get(`${assetPath(pass.downloadToken)}?v=${photo.sha1}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('private, no-store');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('etag')).toBe(`"${photo.sha1}"`);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(oldPhoto);

    const conditional = await get(assetPath(pass.downloadToken), {
      'if-none-match': `"${photo.sha1}"`,
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('cache-control')).toBe('private, no-store');
    expect((await conditional.arrayBuffer()).byteLength).toBe(0);

    const icon = await get(`/p/${pass.downloadToken}/assets/icon.png?v=v1`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('cache-control')).toBe('private, no-store');
    expect(icon.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await icon.arrayBuffer())).toEqual(TINY_PNG);
  }, 120_000);

  it.each([
    {
      name: 'token rotation',
      conditional: false,
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET download_token = ? WHERE id = ?', [
          kit.fx.ids.token(),
          pass.id,
        ]),
    },
    {
      name: 'owner reassignment',
      conditional: false,
      // The transfer removes the member photo itself, so the photo recheck fails first.
      code: 'ASSET_NOT_FOUND',
      change: async (pass: Pass) => {
        const next = await makeUser(kit.fx);
        return startTransfer(pass, next);
      },
    },
    {
      name: 'link generation without changing the token, even for a conditional request',
      conditional: true,
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
          pass.id,
        ]),
    },
    {
      name: 'organization suspension',
      conditional: false,
      change: (pass: Pass) =>
        run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [pass.orgId]),
    },
    {
      name: 'artifact version change',
      conditional: false,
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]),
    },
    {
      name: 'Wallet removal',
      conditional: false,
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
          kit.clock.now(),
          pass.id,
        ]),
    },
    {
      name: 'test data quarantine',
      conditional: false,
      testMode: true,
      change: (pass: Pass) =>
        run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]),
    },
  ])(
    'cancels the photo stream on $name during the R2 read',
    async (scenario) => {
      const { change, conditional } = scenario;
      const org = await makeOrg(kit.fx);
      const { pass, photo } = await photoPass(org.id, 'testMode' in scenario && scenario.testMode);
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
        const object = await originalGet(key, options);
        if (key !== photo.r2_key || !object || opened) return object;
        opened = true;
        await change(pass);
        return observeCancellation(object, () => cancelled++);
      });
      let response: Response;
      try {
        response = await get(
          assetPath(pass.downloadToken),
          conditional ? { 'if-none-match': `"${photo.sha1}"` } : {},
        );
      } finally {
        spy.mockRestore();
      }
      expect(opened).toBe(true);
      expect(cancelled).toBe(1);
      await expectNoImage(response, 'code' in scenario ? scenario.code : undefined);
    },
    120_000,
  );

  it.each(['replacement', 'hash-only change', 'removal'] as const)(
    'rejects a member-photo %s between opening its object and rechecking the pointer',
    async (change) => {
      const { pass, photo } = await photoPass();
      const snapshot = await capturePassSnapshot(kit.ctx, pass);
      const replacement = newHolderPhoto();
      const replacementSha = await sha1Hex(replacement);
      const replacementKey = `member-photos/${pass.orgId}/${pass.id}/${replacementSha}.png`;
      await kit.env.BUCKET.put(replacementKey, replacement);
      expect(replacementSha).not.toBe(photo.sha1);
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
        const object = await originalGet(key, options);
        if (key !== photo.r2_key || !object) return object;
        opened = true;
        if (change === 'replacement') {
          await run(
            kit.env.DB,
            'UPDATE member_photos SET r2_key = ?, sha1 = ?, size = ?, crc32 = ?, version = ? WHERE pass_id = ?',
            [
              replacementKey,
              replacementSha,
              replacement.length,
              crc32(replacement),
              kit.fx.ids.token(16),
              pass.id,
            ],
          );
        } else if (change === 'hash-only change') {
          await run(kit.env.DB, 'UPDATE member_photos SET sha1 = ? WHERE pass_id = ?', [
            replacementSha,
            pass.id,
          ]);
        } else {
          await run(kit.env.DB, 'DELETE FROM member_photos WHERE pass_id = ?', [pass.id]);
        }
        return observeCancellation(object, () => cancelled++);
      });
      let response: Response;
      try {
        response = await get(assetPath(pass.downloadToken), {
          'if-none-match': `"${photo.sha1}"`,
        });
      } finally {
        spy.mockRestore();
      }
      expect(opened).toBe(true);
      expect(cancelled).toBe(1);
      await expectNoImage(response, 'ASSET_NOT_FOUND');
      await expect(assertPassSnapshot(kit.ctx, snapshot)).resolves.toBeUndefined();

      if (change === 'replacement') {
        const current = await get(assetPath(pass.downloadToken));
        expect(current.status).toBe(200);
        expect(current.headers.get('etag')).toBe(`"${replacementSha}"`);
        expect(current.headers.get('cache-control')).toBe('private, no-store');
        expect(new Uint8Array(await current.arrayBuffer())).toEqual(replacement);
      }
    },
    120_000,
  );

  it('cancels an opened pass override if its pointer is removed before rechecking', async () => {
    const created = await kit.pass();
    await putPassAsset(jobCtxOf(kit), actor, created.id, 'icon.png', ICON_PNG, null);
    const pass = await getPass(kit.env.DB, created.id);
    const override = await getPassAsset(kit.env.DB, created.id, 'icon.png');
    if (!pass || !override) throw new Error('Pass override fixture was not stored');
    const snapshot = await capturePassSnapshot(kit.ctx, pass);
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== override.r2Key || !object) return object;
      opened = true;
      await run(kit.env.DB, 'DELETE FROM pass_assets WHERE pass_id = ? AND name = ?', [
        pass.id,
        'icon.png',
      ]);
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await get(`/p/${pass.downloadToken}/assets/icon.png`, {
        'if-none-match': `"${override.sha1}"`,
      });
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    await expectNoImage(response, 'ASSET_NOT_FOUND');
    await expect(assertPassSnapshot(kit.ctx, snapshot)).resolves.toBeUndefined();
  });

  it('does not disclose a newly assigned holder photo to the old bearer', async () => {
    const { pass, owner } = await photoPass();
    const next = await makeUser(kit.fx);
    let newToken = '';
    const newPhoto = newHolderPhoto();
    expect(newPhoto).not.toEqual(oldPhoto);
    let newKey = '';
    let swapped = false;
    let opened = false;
    let cancelled = 0;
    const change = vi.fn(async () => {
      expect((await startTransfer(pass, next)).state).toBe('completed');
      const transferred = await getPass(kit.env.DB, pass.id);
      if (!transferred) throw new Error('Missing transferred pass');
      newToken = transferred.downloadToken;
      await putMemberPhoto(
        jobCtxOf(kit),
        actor,
        pass.id,
        { png: btoa(String.fromCharCode(...newPhoto)), includeInPass: true },
        null,
      );
      const photo = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
      if (!photo) throw new Error('New holder photo was not stored');
      newKey = photo.r2_key;
      swapped = true;
    });
    const env: AppEnv = {
      ...kit.env,
      DB: beforeFirstRead(kit.env.DB, (sql) => sql.includes('FROM member_photos'), change),
    };
    overrideDeps(env, { registry: kit.registry, apns: kit.apns, mailer: kit.mailer });
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (!swapped || key !== newKey || !object) return object;
      opened = true;
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await get(assetPath(pass.downloadToken), {}, env);
    } finally {
      spy.mockRestore();
    }
    expect(change).toHaveBeenCalledOnce();
    expect(owner.id).not.toBe(next.id);
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    await expectNoImage(response);
    expect((await get(assetPath(pass.downloadToken))).status).toBe(404);
    const current = await get(assetPath(newToken));
    expect(current.status).toBe(200);
    expect(current.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await current.arrayBuffer())).toEqual(newPhoto);
  }, 120_000);

  it('cancels a downloaded pass if its link changes during the R2 read', async () => {
    const pass = await kit.pass();
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== pass.objectKey || !object) return object;
      opened = true;
      await run(
        kit.env.DB,
        'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?',
        [pass.id],
      );
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await get(`/p/${pass.downloadToken}/pass.pkpass`);
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    await expectNoImage(response);
  });
});

describe('public page fencing', () => {
  it('does not render newly assigned holder data to an old bearer', async () => {
    const oldName = 'Original Holder Alpha';
    const newName = 'New Holder Secret Bravo';
    const oldOwner = await makeUser(kit.fx);
    const newOwner = await makeUser(kit.fx);
    const pass = await kit.pass({ memberName: oldName, holderEmail: oldOwner.primaryEmail });
    let newToken = '';
    const change = vi.fn(async () => {
      expect((await startTransfer(pass, newOwner)).state).toBe('completed');
      const transferred = await getPass(kit.env.DB, pass.id);
      if (!transferred) throw new Error('Missing transferred pass');
      newToken = transferred.downloadToken;
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET pass_json = replace(pass_json, ?, ?) WHERE pass_id = ?',
        [oldName, newName, pass.id],
      );
    });
    const env: AppEnv = {
      ...kit.env,
      DB: beforeFirstRead(kit.env.DB, (sql) => sql.includes('FROM pass_versions'), change),
    };
    overrideDeps(env, { registry: kit.registry, apns: kit.apns, mailer: kit.mailer });
    const stale = await get(`/p/${pass.downloadToken}`, {}, env);
    expect(change).toHaveBeenCalledOnce();
    expect(stale.status).toBe(404);
    expect(stale.headers.get('cache-control')).toBe('private, no-store');
    expect(await stale.text()).not.toContain(newName);
    const current = await get(`/p/${newToken}`);
    expect(current.status).toBe(200);
    expect(await current.text()).toContain(newName);
  }, 120_000);

  it('fences the page when its bearer changes while wallet offers are being read', async () => {
    // Offers are only read once providers are released.
    const restoreProviders = setWalletProvidersEnabledForTest(true);
    onTestFinished(restoreProviders);
    const { kit: nativeKit, pass } = await setupWalletOfferKit({
      google: 'configured',
      samsung: 'configured',
      db: await isolatedKeysetDatabase(),
    });
    const newOwner = await makeUser(nativeKit.fx);
    let newToken = '';
    const change = vi.fn(async () => {
      expect((await startTransfer(pass, newOwner, nativeKit)).state).toBe('completed');
      const transferred = await getPass(nativeKit.env.DB, pass.id);
      if (!transferred) throw new Error('Missing transferred pass');
      newToken = transferred.downloadToken;
    });
    const env: AppEnv = {
      ...nativeKit.env,
      // The public page has already captured its snapshot; this is offerPassSnapshot's pass-id read.
      DB: beforeFirstRead(
        nativeKit.env.DB,
        (sql) => sql.includes('WHERE id = ? AND (? IS NULL OR org_id = ?)'),
        change,
      ),
    };
    overrideDeps(env, {
      registry: nativeKit.registry,
      apns: nativeKit.apns,
      mailer: nativeKit.mailer,
    });
    const stale = await get(`/p/${pass.downloadToken}`, {}, env);
    expect(change).toHaveBeenCalledOnce();
    expect(stale.status).toBe(404);
    const html = await stale.text();
    expect(html).not.toContain(newToken);
    expect(html).not.toContain('/wallet/google');
    expect(html).not.toContain('/wallet/samsung');
    const current = await get(`/p/${newToken}`, {}, nativeKit.env);
    expect(current.status).toBe(200);
    const currentHtml = await current.text();
    expect(currentHtml).toContain(`href="/p/${newToken}/pass.pkpass"`);
    expect(currentHtml).not.toContain(`href="/p/${newToken}/wallet/google"`);
    expect(currentHtml).not.toContain(`href="/p/${newToken}/wallet/samsung"`);
  }, 90_000);

  it('uses the latest JSON at or before a metadata-only version, never a future version', async () => {
    const currentName = 'Pinned Holder Charlie';
    const futureName = 'Future Holder Secret Delta';
    const pass = await kit.pass({ memberName: currentName });
    const row = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? AND version = ?',
      [pass.id, pass.version],
    );
    if (!row?.pass_json) throw new Error('Published pass JSON was not stored');
    expect(row.pass_json).toContain(currentName);
    await run(
      kit.env.DB,
      `INSERT INTO pass_versions (pass_id, version, template_version, personalization, pass_json, cause, created_at)
       SELECT pass_id, version + 2, template_version, personalization, ?, cause, created_at
       FROM pass_versions WHERE pass_id = ? AND version = ?`,
      [row.pass_json.replaceAll(currentName, futureName), pass.id, pass.version],
    );
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    const response = await get(`/p/${pass.downloadToken}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(currentName);
    expect(html).not.toContain(futureName);

    await run(kit.env.DB, 'DELETE FROM pass_versions WHERE pass_id = ? AND version = ?', [
      pass.id,
      pass.version,
    ]);
    const missing = await get(`/p/${pass.downloadToken}`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(futureName);
  });
});
