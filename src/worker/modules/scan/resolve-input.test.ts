import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { door, kit, resolve, setupResolveFixture, tpl } from './resolve-test-fixtures.ts';
import { key } from './test-kit.ts';

beforeAll(setupResolveFixture);

describe('resolve: input normalisation', () => {
  it('strips the CR, LF and Tab a wedge reader appends', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    for (const tail of ['\r\n', '\t', '\r']) {
      const { out } = await resolve(s.headers, {
        code: `${pass.scanCode}${tail}`,
        method: 'wedge',
      });
      expect(out.kind).toBe('ready');
    }
  });

  it('a typed scan code with spaces, dashes and lower case still matches', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    const typed = (pass.scanCode ?? '').toLowerCase().replace(/(.{4})/g, '$1 - ');
    expect((await resolve(s.headers, { code: typed, method: 'manual' })).out.kind).toBe('ready');
  });

  it('a non-ASCII barcode finds the pass by the hash the publish writes', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    const barcode = 'Zoë-Ünï-№7';
    await run(kit.env.DB, 'UPDATE passes SET barcode_hash = ?, revision=revision+1 WHERE id = ?', [
      await sha256Hex(barcode),
      pass.id,
    ]);
    const { out } = await resolve(s.headers, { code: `${barcode}\n`, method: 'wedge' });
    expect(out.card?.passId).toBe(pass.id);
  });

  it('a typed member number finds the pass by lookup hash', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl, { memberNo: 'GYM-0042' });
    await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ?, revision=revision+1 WHERE id = ?', [
      await sha256Hex(normalizeLookup('GYM-0042')),
      pass.id,
    ]);
    expect(
      (await resolve(s.headers, { code: 'gym 0042', method: 'manual' })).out.card?.passId,
    ).toBe(pass.id);
  });

  it('only manual serial or an explicit pass selection can identify a pass', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    const external = 'external-selection-only';
    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [external, pass.id]);
    expect((await resolve(s.headers, { code: pass.id, method: 'manual' })).out.reason).toBe(
      'not_found',
    );
    expect((await resolve(s.headers, { code: external, method: 'manual' })).out.reason).toBe(
      'not_found',
    );
    expect((await resolve(s.headers, { code: pass.serial, method: 'camera' })).out.reason).toBe(
      'not_found',
    );
    expect(
      (await resolve(s.headers, { code: pass.serial, method: 'manual' })).out.card?.passId,
    ).toBe(pass.id);
    expect((await resolve(s.headers, { passId: pass.id, method: 'manual' })).out.card?.passId).toBe(
      pass.id,
    );
  });

  it.each([
    { mode: 'live', otherMode: 'test' },
    { mode: 'test', otherMode: 'live' },
  ] as const)(
    'prefers a $mode credential over an opposite-mode scan-code match',
    async ({ mode, otherMode }) => {
      const scanner = await door([tpl], { mode });
      const other = await kit.scanPass(tpl, {}, { mode: otherMode });
      const current = await kit.scanPass(tpl, {}, { mode });
      if (!other.scanCode) throw new Error('Missing opposite-mode scan code');
      await run(kit.env.DB, 'UPDATE passes SET barcode_hash=?, revision=revision+1 WHERE id=?', [
        await sha256Hex(other.scanCode),
        current.id,
      ]);
      const input = { code: other.scanCode, method: 'camera' as const };
      expect((await resolve(scanner.headers, input)).out.card?.passId).toBe(current.id);
      await stagePendingCredentialTransfer(kit.env.DB, other.id, {
        id: kit.fx.ids.id(),
        token: kit.fx.ids.token(),
        now: kit.clock.now(),
        targetHolderEmail: 'next-mode@example.test',
      });
      expect((await resolve(scanner.headers, input)).out.card?.passId).toBe(current.id);
    },
  );

  it.each([
    { mode: 'live', otherMode: 'test' },
    { mode: 'test', otherMode: 'live' },
  ] as const)(
    'does not let opposite-mode matches consume the $mode candidate cap',
    async ({ mode, otherMode }) => {
      const scanner = await door([tpl], { mode });
      const code = `shared-mode-${key()}`;
      const hash = await sha256Hex(code);
      for (let i = 0; i < 6; i++) {
        const other = await kit.scanPass(tpl, {}, { mode: otherMode });
        await run(kit.env.DB, 'UPDATE passes SET barcode_hash=?, revision=revision+1 WHERE id=?', [
          hash,
          other.id,
        ]);
      }
      const current = await kit.scanPass(tpl, {}, { mode });
      await run(kit.env.DB, 'UPDATE passes SET barcode_hash=?, revision=revision+1 WHERE id=?', [
        hash,
        current.id,
      ]);
      expect((await resolve(scanner.headers, { code, method: 'camera' })).out.card?.passId).toBe(
        current.id,
      );
    },
  );
});
