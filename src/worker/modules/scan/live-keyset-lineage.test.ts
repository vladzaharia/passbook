import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { createScannerStore } from './auth-store.ts';
import { liveRecipient } from './live-auth.ts';
import { openLiveSourceProof, sealLiveSourceProof } from './live-provenance.ts';
import { liveRowFor } from './live-render.ts';
import { copyScanEpochs } from './scan-epochs.ts';
import { hub, kit, observeCancellation, photoFixture } from './scan-hub-test-fixtures.ts';

describe('live credential keyset authority', () => {
  it('freezes the original actor, input refs and own KEK values before sealing yields', async () => {
    const fixture = await photoFixture();
    const retained = await hub().sourceProof(fixture.event.id);
    if (!retained) throw new Error('Missing retained source proof.');
    const original = await openLiveSourceProof(kit.env, retained);
    if (!original) throw new Error('Missing decoded source proof.');
    const mutable = structuredClone(original);
    copyScanEpochs(original.actor, mutable.actor); // structuredClone drops the epochs' symbol key
    const env = { ...kit.env } as typeof kit.env & Record<string, unknown>;
    const keys = Object.keys(env).filter((name) => /^KEK_V\d+$/.test(name));
    if (!keys.length) throw new Error('Missing source KEK.');
    const pending = sealLiveSourceProof(env, mutable);
    mutable.actor.name = 'changed-after-seal';
    mutable.credentialContext.credentialTombstoneRefs = ['a'.repeat(64)];
    mutable.credentialContext.otherModeCredentialTombstoneRefs = ['b'.repeat(64)];
    for (const name of keys) env[name] = btoa(String.fromCharCode(...new Uint8Array(32).fill(72)));
    const sealed = await pending;
    expect(await openLiveSourceProof(kit.env, sealed)).toEqual(original);
  });

  it.each(['missing', 'mismatch', 'after-open'] as const)(
    'fails closed for a %s original keyset even with no input refs',
    async (change) => {
      const fixture = await photoFixture();
      const sentinel = await first<{ commitment: string }>(
        kit.env.DB,
        'SELECT commitment FROM credential_ref_keyset WHERE id = 1',
      );
      const sealed = await hub().sourceProof(fixture.event.id);
      const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
      if (!sentinel || !sealed || !stored) throw new Error('Missing keyset fixture.');
      const proof = await openLiveSourceProof(kit.env, sealed);
      expect(proof?.passSnapshot?.credentialTombstoneRefs).toEqual([]);
      expect(proof?.passSnapshot?.otherModeCredentialTombstoneRefs).toEqual([]);
      expect(proof?.passSnapshot?.credentialKeysetCommitment).toBe(sentinel.commitment);
      expect(proof?.credentialContext.credentialKeysetCommitment).toBe(sentinel.commitment);
      expect(fixture.path).not.toContain(sentinel.commitment);
      expect(JSON.stringify(fixture.event)).not.toContain(sentinel.commitment);
      const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
      if (!recipient) throw new Error('Missing monitor recipient.');
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);

      // Redirect only the keyset table; never mutate the protected production sentinel.
      const table = `test_live_keyset_${kit.ctx.ids.token(8).replace(/[^a-zA-Z0-9]/g, '')}`;
      await run(
        kit.env.DB,
        `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, commitment TEXT NOT NULL)`,
      );
      const different = sentinel.commitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
      if (change !== 'missing')
        await run(kit.env.DB, `INSERT INTO ${table} (id, commitment) VALUES (1, ?)`, [
          change === 'mismatch' ? different : sentinel.commitment,
        ]);
      const db = new Proxy(kit.env.DB, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => target.prepare(sql.replaceAll('credential_ref_keyset', table));
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const app = createApp({
        stores: { ...denyAllStores, scanners: createScannerStore(kit.env, kit.clock) },
        clock: kit.clock,
      });
      const env = { ...kit.env, DB: db };
      const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
      let opened = false;
      let cancelled = 0;
      const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (objectKey, options) => {
        const object = await originalGet(objectKey, options);
        if (objectKey !== stored.r2_key || !object) return object;
        opened = true;
        if (change === 'after-open')
          await run(kit.env.DB, `UPDATE ${table} SET commitment = ? WHERE id = 1`, [different]);
        return observeCancellation(object, () => {
          cancelled++;
        });
      });
      try {
        const response = await app.request(
          `https://wallet.test/api/v1/scan${fixture.path}`,
          { headers: fixture.monitor.headers },
          env,
        );
        expect(response.status).toBe(404);
        if (change === 'after-open') {
          expect(opened).toBe(true);
          expect(cancelled).toBe(1);
        } else {
          expect(opened).toBe(false);
        }
        const internal = { ...fixture.event, sourceProof: sealed };
        const projection = await liveRowFor({ ...kit.ctx, env }, recipient, internal);
        expect(projection).toMatchObject({ passId: null, holder: null, photoUrl: null });
      } finally {
        spy.mockRestore();
        await run(kit.env.DB, `DROP TABLE ${table}`);
      }
    },
  );
});
