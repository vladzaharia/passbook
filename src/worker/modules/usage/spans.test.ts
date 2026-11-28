import { beforeAll, describe, expect, it } from 'vitest';
import type { EventKind } from '../../../shared/contracts/events.ts';
import { first, run } from '../../platform/db.ts';
import { recordPassEvent } from '../events/record.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { dailyCloseSpans } from './jobs-spans.ts';
import { closeEndedSpans, spansOfPass } from './repo-spans.ts';
import { SPAN_IDLE_MS } from './spans.ts';

const T0 = Date.UTC(2026, 6, 1);
const DAY = 86_400_000;
let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

type PassRef = Pick<Pass, 'id' | 'orgId' | 'mode'>;
const ev = (
  pass: PassRef,
  kind: EventKind,
  at: number,
  data: Record<string, string> = {},
  mode: 'live' | 'test' = pass.mode,
) => recordPassEvent(kit.ctx, { orgId: pass.orgId, passId: pass.id, mode, kind, at, data });
const sql = (q: string, p: (string | number | null)[]) => run(kit.env.DB, q, p);
const voidIt = (p: PassRef, at: number) =>
  sql("UPDATE passes SET status = 'voided', modified_at = ? WHERE id = ?", [at, p.id]);
const setExpiry = (p: PassRef, version: number, iso: string | null) =>
  sql(
    `INSERT INTO pass_versions (pass_id, version, template_version, personalization, pass_json, cause, created_at)
     VALUES (?, ?, '1', '{}', ?, 'admin', ?)`,
    [p.id, version, JSON.stringify(iso ? { expirationDate: iso } : {}), T0],
  );
const move = (old: PassRef, next: PassRef) =>
  sql(
    `INSERT INTO pass_moves (id, op_id, org_id, mode, from_identity_id, to_identity_id, old_pass_id, new_pass_id,
       state, created_at, updated_at) VALUES (?, 'op', ?, 'live', 'a', 'b', ?, ?, 'registered', 1, 1)`,
    [kit.fx.ids.id(), old.orgId, old.id, next.id],
  );

describe('span start', () => {
  const starts: [EventKind, Record<string, string>, string][] = [
    ['device.registered', {}, 'apple'],
    ['wallet.saved', { provider: 'google' }, 'google'],
    ['wallet.saved', { provider: 'samsung' }, 'samsung'],
    ['pass.printed', {}, 'web'],
    ['scan.checked_in', {}, 'web'],
    ['scan.redeemed', {}, 'web'],
    ['scan.checked_out', {}, 'web'],
    ['scan.adjusted', {}, 'web'],
  ];
  it.each(starts)('%s %j starts a %s span', async (kind, data, platform) => {
    const pass = await kit.pass();
    await ev(pass, kind, T0, data);
    const [span] = await spansOfPass(kit.env.DB, pass.id);
    expect(span).toMatchObject({ platform, liveFrom: T0, liveTo: null, lastUsedAt: T0 });
    const usage = await first<{ first_taken_at: number }>(
      kit.env.DB,
      'SELECT first_taken_at FROM pass_usage WHERE pass_id = ?',
      [pass.id],
    );
    expect(usage?.first_taken_at).toBe(T0);
  });

  it('ignores Test passes and Test events', async () => {
    const test = await kit.pass({ mode: 'test' });
    await ev(test, 'device.registered', T0);
    const live = await kit.pass();
    await ev(live, 'device.registered', T0, {}, 'test');
    expect(await spansOfPass(kit.env.DB, test.id)).toEqual([]);
    expect(await spansOfPass(kit.env.DB, live.id)).toEqual([]);
  });

  it('does not start on a fetch or a non-taken kind, but a fetch extends', async () => {
    const pass = await kit.pass();
    await ev(pass, 'device.fetched', T0);
    await ev(pass, 'pass.updated', T0);
    await ev(pass, 'page.opened', T0);
    expect(await spansOfPass(kit.env.DB, pass.id)).toEqual([]);
    await ev(pass, 'device.registered', T0 + 1);
    await ev(pass, 'device.fetched', T0 + 5 * DAY);
    const spans = await spansOfPass(kit.env.DB, pass.id);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.lastUsedAt).toBe(T0 + 5 * DAY);
  });

  it('a web span becomes Apple when a device registers', async () => {
    const pass = await kit.pass();
    await ev(pass, 'scan.checked_in', T0);
    await ev(pass, 'device.registered', T0 + 1);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]?.platform).toBe('apple');
  });
});

describe('span end', () => {
  it('void', async () => {
    const pass = await kit.pass();
    await ev(pass, 'device.registered', T0);
    await voidIt(pass, T0 + DAY);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]).toMatchObject({
      liveTo: T0 + DAY,
      endReason: 'void',
    });
  });

  it('removal', async () => {
    const pass = await kit.pass();
    await ev(pass, 'wallet.saved', T0, { provider: 'google' });
    await sql('UPDATE passes SET removed_at = ? WHERE id = ?', [T0 + 2 * DAY, pass.id]);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]).toMatchObject({
      liveTo: T0 + 2 * DAY,
      endReason: 'removal',
    });
  });

  it('a released removal or an unvoid reopens the span', async () => {
    const pass = await kit.pass();
    await ev(pass, 'device.registered', T0);
    await sql('UPDATE passes SET removed_at = ? WHERE id = ?', [T0 + DAY, pass.id]);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]?.endReason).toBe('removal');
    await sql('UPDATE passes SET removed_at = NULL WHERE id = ?', [pass.id]);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]).toMatchObject({
      liveTo: null,
      endReason: null,
    });
    await voidIt(pass, T0 + 2 * DAY);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]?.endReason).toBe('void');
    await sql("UPDATE passes SET status = 'active' WHERE id = ?", [pass.id]);
    const spans = await spansOfPass(kit.env.DB, pass.id);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ liveTo: null, endReason: null });
  });

  it('deletion', async () => {
    const pass = await kit.pass();
    await ev(pass, 'pass.printed', T0);
    await sql('UPDATE passes SET deleted_at = ? WHERE id = ?', [T0 + 3 * DAY, pass.id]);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]).toMatchObject({
      liveTo: T0 + 3 * DAY,
      endReason: 'deletion',
    });
  });

  it('the last Apple device unregistering ends the span, an earlier one does not', async () => {
    const pass = await kit.pass();
    await kit.device(pass, 'device-one', 'a'.repeat(64));
    await kit.device(pass, 'device-two', 'b'.repeat(64));
    await ev(pass, 'device.registered', T0);
    await sql('DELETE FROM registrations WHERE device_id = ?', ['device-one']);
    await ev(pass, 'device.unregistered', T0 + DAY);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]?.liveTo).toBeNull();
    await sql('DELETE FROM registrations WHERE device_id = ?', ['device-two']);
    await ev(pass, 'device.unregistered', T0 + 2 * DAY);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]).toMatchObject({
      liveTo: T0 + 2 * DAY,
      endReason: 'unregistered',
    });
  });

  it('Google and Samsung spans ignore an unregister signal', async () => {
    for (const provider of ['google', 'samsung']) {
      const pass = await kit.pass();
      await ev(pass, 'wallet.saved', T0, { provider });
      await ev(pass, 'device.unregistered', T0 + DAY);
      expect((await spansOfPass(kit.env.DB, pass.id))[0]?.liveTo).toBeNull();
    }
  });

  it('expiry: the version date bounds the span and the job stamps it', async () => {
    const pass = await kit.pass();
    await ev(pass, 'wallet.saved', T0, { provider: 'google' });
    await setExpiry(pass, 90, new Date(T0 + 10 * DAY).toISOString());
    expect((await spansOfPass(kit.env.DB, pass.id))[0]?.expiresAt).toBe(T0 + 10 * DAY);
    const effective = () =>
      first<{ effective_to: number; effective_reason: string }>(
        kit.env.DB,
        'SELECT effective_to, effective_reason FROM pass_live_spans_effective WHERE pass_id = ?',
        [pass.id],
      );
    expect(await effective()).toEqual({ effective_to: T0 + 10 * DAY, effective_reason: 'expiry' });
    kit.clock.set(T0 + 11 * DAY);
    await dailyCloseSpans(kit.ctx);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]).toMatchObject({
      liveTo: T0 + 10 * DAY,
      endReason: 'expiry',
    });
    await setExpiry(pass, 91, null);
  });

  it('removing the date clears the expiry', async () => {
    const pass = await kit.pass();
    await setExpiry(pass, 90, new Date(T0 + DAY).toISOString());
    await ev(pass, 'wallet.saved', T0, { provider: 'google' });
    await setExpiry(pass, 91, null);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]?.expiresAt).toBeNull();
  });

  it('idle: 90 days without use, read by the gauge before the job and stamped by it', async () => {
    const pass = await kit.pass();
    await ev(pass, 'wallet.saved', T0, { provider: 'samsung' });
    await ev(pass, 'device.fetched', T0 + 10 * DAY);
    const end = T0 + 10 * DAY + SPAN_IDLE_MS;
    const row = await first<{ effective_to: number; effective_reason: string }>(
      kit.env.DB,
      'SELECT effective_to, effective_reason FROM pass_live_spans_effective WHERE pass_id = ?',
      [pass.id],
    );
    expect(row).toEqual({ effective_to: end, effective_reason: 'idle' });
    await closeEndedSpans(kit.env.DB, end - 1, 1000);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]?.liveTo).toBeNull();
    await closeEndedSpans(kit.env.DB, end, 1000);
    expect((await spansOfPass(kit.env.DB, pass.id))[0]).toMatchObject({
      liveTo: end,
      endReason: 'idle',
    });
  });

  it('a late event closes the stale span and starts a new one', async () => {
    const pass = await kit.pass();
    await ev(pass, 'device.registered', T0);
    const later = T0 + 200 * DAY;
    await ev(pass, 'device.registered', later);
    const spans = await spansOfPass(kit.env.DB, pass.id);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ liveTo: T0 + SPAN_IDLE_MS, endReason: 'idle' });
    expect(spans[1]).toMatchObject({ liveFrom: later, liveTo: null });
  });
});

describe('identity move', () => {
  it('keeps one continuous span across the replacement and its void of the old pass', async () => {
    const old = await kit.pass();
    const next = await kit.pass();
    await ev(old, 'device.registered', T0);
    await move(old, next);
    await ev(next, 'device.registered', T0 + DAY);
    const carried = await spansOfPass(kit.env.DB, next.id);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ liveFrom: T0, liveTo: null });
    expect(await spansOfPass(kit.env.DB, old.id)).toEqual([]);
    await voidIt(old, T0 + 2 * DAY);
    expect((await spansOfPass(kit.env.DB, next.id))[0]?.liveTo).toBeNull();
    await ev(old, 'device.fetched', T0 + 3 * DAY);
    expect((await spansOfPass(kit.env.DB, next.id))[0]?.lastUsedAt).toBe(T0 + 3 * DAY);
    await voidIt(next, T0 + 4 * DAY);
    expect((await spansOfPass(kit.env.DB, next.id))[0]).toMatchObject({
      liveFrom: T0,
      liveTo: T0 + 4 * DAY,
      endReason: 'void',
    });
  });

  it('a void of the old pass before the replacement registers carries the span', async () => {
    const old = await kit.pass();
    const next = await kit.pass();
    await ev(old, 'device.registered', T0);
    await move(old, next);
    await voidIt(old, T0 + DAY);
    const [span] = await spansOfPass(kit.env.DB, next.id);
    expect(span).toMatchObject({ liveFrom: T0, liveTo: null });
  });
});
