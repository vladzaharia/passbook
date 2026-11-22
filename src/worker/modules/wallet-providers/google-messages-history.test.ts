// GM2: the object's `messages`, retention, the budget the ledger gives, and the gates (google-messages.md section 11, 10-12, 14, 16, 17).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPass } from '../passes/repo-read-pass.ts';
import { deletePass } from '../passes/service.ts';
import { setPassStatus } from '../passes/service-status.ts';
import { messageKit } from './google-messages-test-fixtures.ts';
import { providerBudgets } from './notify-budget.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

let restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  vi.unstubAllGlobals();
});

const system = { type: 'system', id: null } as const;
describe('the object history', () => {
  it('an unvoid drops the voided message from the card and sends no new one', async () => {
    const t = await messageKit(restore);
    await setPassStatus(t.jobCtx, system, t.f.pass.id, 'voided', null);
    await t.drain();
    expect(t.messages()).toMatchObject([{ body: expect.any(String) }]);
    expect(t.object()?.state).toBe('INACTIVE');
    const mark = t.mock.requests.length;
    await setPassStatus(t.jobCtx, system, t.f.pass.id, 'active', null);
    await t.drain();
    expect(t.patchedMessages(mark)).toEqual([]);
    expect(t.messages()).toEqual([]);
    expect(t.sent()).toEqual([]);
  });

  it('eleven delivered messages: the PATCH carries the newest nine as TEXT', async () => {
    const t = await messageKit(restore);
    for (let i = 1; i <= 11; i++) {
      await t.edit(`Name ${i}`);
      t.kit.clock.advance(60_000);
    }
    const mark = t.mock.requests.length;
    await t.edit('Name 12');
    const sent = t.patchedMessages(mark);
    expect(sent).toHaveLength(9);
    expect(sent.every((m) => m.messageType === 'TEXT')).toBe(true);
    expect(t.messages()).toHaveLength(10);
  });
});

describe('what never messages', () => {
  it('a revoke calls no addMessage', async () => {
    const t = await messageKit(restore);
    await deletePass(t.jobCtx, system, t.f.pass.id, null);
    await t.drain();
    expect(t.sent()).toEqual([]);
    expect(t.object()?.state).toBe('INACTIVE');
  });

  it('a provider that is not released calls nothing', async () => {
    const t = await messageKit(restore);
    restore.push(setWalletProvidersEnabledForTest(false));
    const mark = t.mock.requests.length;
    await t.edit('One');
    expect(t.mock.requests.slice(mark)).toEqual([]);
    expect(await t.ledger()).toEqual([]);
  });
});

describe('retention', () => {
  it('removes settled rows older than 35 days and keeps a row still sending', async () => {
    const t = await messageKit(restore);
    await t.edit('One');
    const row = await t.first<{
      instance_id: string;
      operation_id: string;
      ciphertext: ArrayBuffer;
    }>(t.db, 'SELECT instance_id, operation_id, ciphertext FROM wallet_google_messages');
    const old = t.kit.clock.now() - 40 * 86_400_000;
    const insert = (id: string, base: number, state: string, settled: number | null) =>
      t.db
        .prepare(
          `INSERT INTO wallet_google_messages (id, instance_id, operation_id, base_version, target_version, notify,
             state, tries, kek_version, iv, wrapped_dek, ciphertext, created_at, settled_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 1, 1, x'00', x'00', x'00', ?, ?)`,
        )
        .bind(id, row?.instance_id, row?.operation_id, base, base + 1, state, old, settled)
        .run();
    await insert('old-notified', 10, 'notified', old);
    await insert('old-sending', 20, 'sending', null);
    await t.drain();
    const ids = (await t.db.prepare('SELECT id FROM wallet_google_messages').all()).results.map(
      (r) => (r as { id: string }).id,
    );
    expect(ids).toContain('old-sending');
    expect(ids).not.toContain('old-notified');
    expect(ids).toHaveLength(2);
  });
});

describe('the budget the ledger gives', () => {
  it('counts what Google accepted, a quota refusal spends it, and the window rolls on', async () => {
    const t = await messageKit(restore);
    const budget = async () =>
      providerBudgets(t.kit.ctx, (await getPass(t.db, t.f.pass.id)) ?? t.f.pass);
    expect(await budget()).toEqual({ google: { used: 0, limit: 3, resetsAt: null } });
    for (const name of ['One', 'Two']) {
      await t.edit(name);
      t.kit.clock.advance(60_000);
    }
    expect((await budget()).google).toMatchObject({ used: 2, limit: 3 });
    t.mock.seedNotifications('genericObject', String(t.object()?.id), 3);
    await t.edit('Three');
    const spent = (await budget()).google;
    expect(spent).toMatchObject({ used: 3, limit: 3 });
    expect(spent?.resetsAt).toBeGreaterThan(t.kit.clock.now());
    t.kit.clock.advance(25 * 3_600_000);
    expect((await budget()).google).toMatchObject({ used: 0 });
  });
});
