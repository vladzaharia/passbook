import { describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run } from '../../platform/db.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { lookup } from './lookup.ts';
import {
  hiddenLookupFixture,
  interceptBatches,
  kit,
  registerLookupOutputFixture,
  resolveRequest,
  scannerForLookup,
  setupPhoto,
  templateId,
} from './lookup-output-test-fixtures.ts';
import { RACE_GRANT_INSERT, RACE_MISS_COUNTER } from './race-tags.ts';
import { missCounterKey } from './repo-miss-authority.ts';
import { isFinalFenceBatch } from './repo-read-grant-expiry-test-fixtures.ts';
import { resolveOutcome } from './resolve-outcome.ts';

registerLookupOutputFixture();

describe('lookup output authority', () => {
  it('does not count an unknown race when the final pass fence rejects a projected item', async () => {
    const pass = await setupPhoto();
    const { actor } = await scannerForLookup();
    const real = kit.env.DB;
    let invalidated = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (!invalidated && isFinalFenceBatch(sql)) {
        invalidated = true;
        await run(real, "UPDATE passes SET status='voided', revision=revision+1 WHERE id=?", [
          pass.id,
        ]);
      }
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    await getPlatformSettings(ctx);
    expect(await lookup(ctx, actor, 'lookup-photo-group')).toEqual({ items: [], more: false });
    expect(invalidated).toBe(true);
    const window = kit.clock.now() - (kit.clock.now() % 600_000);
    expect(
      await first(real, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        missCounterKey(actor),
        window,
      ]),
    ).toBeNull();
    const audit = await first<{ detail: string }>(
      real,
      "SELECT detail FROM audit_log WHERE action='scan.lookup' ORDER BY id DESC LIMIT 1",
    );
    expect(audit).toBeNull();
  });

  it('counts a proven empty lookup in the final actor and credential transaction', async () => {
    await setupPhoto();
    const { actor } = await scannerForLookup();
    const { db, batches } = interceptBatches(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    expect(await lookup(ctx, actor, 'unmatched-lookup-219')).toEqual({ items: [], more: false });
    const window = kit.clock.now() - (kit.clock.now() % 600_000);
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        missCounterKey(actor),
        window,
      ]),
    ).toEqual({ count: 1 });
    // The miss is its own grant: the actor, the credential's refs and the search window hold with it.
    const missBatch = batches.find(
      (batch) =>
        batch.some((sql) => sql.includes(RACE_MISS_COUNTER)) &&
        batch.some((sql) => sql.includes(RACE_GRANT_INSERT)),
    );
    expect(missBatch).toBeDefined();
  });

  it('counts a role-hidden lookup only after its full candidate window is revalidated', async () => {
    const { pass, actor } = await hiddenLookupFixture();
    const result = await lookup(kit.ctx, actor, 'Hidden');
    expect(result).toEqual({ items: [], more: false });
    expect(JSON.stringify(result)).not.toContain(pass.id);
    const window = kit.clock.now() - (kit.clock.now() % 600_000);
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        missCounterKey(actor),
        window,
      ]),
    ).toEqual({ count: 1 });
  });

  it('does not count a hidden lookup when its original candidate leaves the window before the count', async () => {
    const { pass, actor } = await hiddenLookupFixture();
    const real = kit.env.DB;
    let changed = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (!changed && sql.some((text) => text.includes(RACE_GRANT_INSERT))) {
        changed = true;
        await run(real, "UPDATE passes SET status='voided', revision=revision+1 WHERE id=?", [
          pass.id,
        ]);
      }
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    expect(await lookup(ctx, actor, 'Hidden')).toEqual({ items: [], more: false });
    expect(changed).toBe(true);
    const window = kit.clock.now() - (kit.clock.now() % 600_000);
    expect(
      await first(real, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        missCounterKey(actor),
        window,
      ]),
    ).toBeNull();
  });

  it('does not count an otherwise hidden lookup while a matching credential transfer is pending', async () => {
    const { actor } = await hiddenLookupFixture();
    const pending = await kit.scanPass(templateId, { memberName: 'Hidden Pending Member' });
    await stagePendingCredentialTransfer(kit.env.DB, pending.id, {
      id: kit.fx.ids.id(),
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    expect(await lookup(kit.ctx, actor, 'Hidden')).toEqual({ items: [], more: false });
    const window = kit.clock.now() - (kit.clock.now() % 600_000);
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        missCounterKey(actor),
        window,
      ]),
    ).toBeNull();
  });

  it('does not count a resolve miss when a matching credential appears before the final fence', async () => {
    const pass = await setupPhoto();
    const { actor } = await scannerForLookup();
    const real = kit.env.DB;
    const code = 'late-arriving-barcode-219';
    const barcodeHash = await barcodeHashOfCode(cleanCode(code));
    let changed = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (!changed && sql.some((text) => text.includes(RACE_MISS_COUNTER))) {
        changed = true;
        await run(real, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
          barcodeHash,
          pass.id,
        ]);
      }
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    const result = await resolveOutcome(ctx, actor, {
      ...resolveRequest(code),
      input: { code, method: 'manual' },
    });
    expect(changed).toBe(true);
    expect(result.outcome).toMatchObject({ reason: 'not_found', card: null, display: null });
    expect(result.credentialContext).toBeNull();
    const window = kit.clock.now() - (kit.clock.now() % 600_000);
    expect(
      await first(real, 'SELECT count FROM counters WHERE key=? AND window_start=?', [
        missCounterKey(actor),
        window,
      ]),
    ).toBeNull();
  });
});
