import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let tpl: string;
const HOUR = 3_600_000;
const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

beforeAll(async () => {
  kit = await setupScanKit();
  tpl = await kit.scanTemplate('Gym card', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    lookup: { input: 'memberNo' },
    window: { from: 'startsAt', until: 'endsAt' },
    flags: [{ input: 'tier', label: 'Unpaid dues', equals: ['overdue'], stop: true }],
  });
});

const body = (input: unknown) => ({ idempotencyKey: key(), input, clientTs: kit.clock.now() });
const resolve = async (headers: Record<string, string>, input: unknown) => {
  const res = await kit.post(headers, '/resolve', body(input));
  return { status: res.status, out: (await res.json()) as ScanOutcome };
};
const mask = (o: ScanOutcome) => ({ ...o, scanId: null, at: null });

async function door(templateIds = [tpl], over: Record<string, unknown> = {}) {
  return kit.scanner({ templateIds, ...over });
}

describe('resolve: one fixture per reason', () => {
  it('a pass of the scanner answers ready with a card and the identity display', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    const { status, out } = await resolve(s.headers, codeOf(pass));
    expect(status).toBe(200);
    expect(out).toMatchObject({ kind: 'ready', reason: 'choose', scanId: null, replay: false });
    expect(out.card?.passId).toBe(pass.id);
    expect(out.card?.display.identity.holder).toBe('Anna Popescu');
    expect(out.card?.actions[0]).toMatchObject({ id: 'check_in', available: true, lock: null });
  });

  it('not_found', async () => {
    const s = await door();
    const { out } = await resolve(s.headers, { code: 'NOPE-NOT-A-PASS', method: 'camera' });
    expect(out).toMatchObject({ kind: 'refused', reason: 'not_found', card: null, display: null });
  });

  it('ambiguous: two passes share a member number', async () => {
    const s = await door();
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const hash = await sha256Hex(normalizeLookup('AMB-1'));
    for (const p of [a, b])
      await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ? WHERE id = ?', [hash, p.id]);
    const { out } = await resolve(s.headers, { code: 'amb 1', method: 'wedge' });
    expect(out).toMatchObject({ kind: 'refused', reason: 'ambiguous' });
  });

  it('narrowing removes ambiguity: the other pass is of a template this scanner does not accept', async () => {
    const other = await kit.scanTemplate('Other card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const s = await door();
    const [a, b] = [await kit.scanPass(tpl), await kit.scanPass(other)];
    const hash = await sha256Hex(normalizeLookup('NARROW-1'));
    for (const p of [a, b])
      await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ? WHERE id = ?', [hash, p.id]);
    const { out } = await resolve(s.headers, { code: 'NARROW-1', method: 'manual' });
    expect(out.kind).toBe('ready');
    expect(out.card?.passId).toBe(a.id);
  });

  it('test_pass and live_pass carry only the template, no card and no display', async () => {
    const live = await door();
    const test = await door([tpl], { mode: 'test' });
    const testPass = await kit.scanPass(tpl, {}, { mode: 'test' });
    const livePass = await kit.scanPass(tpl);
    const a = await resolve(live.headers, codeOf(testPass));
    expect(a.out).toMatchObject({
      kind: 'refused',
      reason: 'test_pass',
      card: null,
      display: null,
    });
    expect(a.out.template).toEqual({ name: 'Gym card', style: 'generic' });
    expect(JSON.stringify(a.out)).not.toContain('Anna');
    const b = await resolve(test.headers, codeOf(livePass));
    expect(b.out).toMatchObject({ reason: 'live_pass', card: null, display: null });
  });

  it('not_accepted: a pass of another template', async () => {
    const other = await kit.scanTemplate('Other card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const s = await door();
    const { out } = await resolve(s.headers, codeOf(await kit.scanPass(other)));
    expect(out).toMatchObject({ kind: 'refused', reason: 'not_accepted' });
    expect(out.template?.name).toBe('Other card');
  });

  it('wrong_event: the event matches another tier', async () => {
    const ev = await kit.event({ templateIds: [tpl] });
    await run(kit.env.DB, 'UPDATE scan_events SET match_input = ?, match_values = ? WHERE id = ?', [
      'tier',
      '["gold"]',
      ev.id,
    ]);
    const s = await door([], { eventId: ev.id });
    const gold = await kit.scanPass(tpl, { tier: 'gold' });
    const silver = await kit.scanPass(tpl, { tier: 'silver' });
    expect((await resolve(s.headers, codeOf(gold))).out.kind).toBe('ready');
    expect((await resolve(s.headers, codeOf(silver))).out).toMatchObject({ reason: 'wrong_event' });
  });

  it('removed, voided and expired; removed beats expired', async () => {
    const s = await door();
    const removed = await kit.scanPass(tpl);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      kit.clock.now() - HOUR,
      removed.id,
    ]);
    expect((await resolve(s.headers, codeOf(removed))).out).toMatchObject({
      reason: 'removed',
      at: kit.clock.now() - HOUR,
    });
    const voided = await kit.scanPass(tpl);
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.id]);
    expect((await resolve(s.headers, codeOf(voided))).out.reason).toBe('voided');
    const expired = await kit.scanPass(tpl);
    const past = new Date(kit.clock.now() - HOUR).toISOString();
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?`,
      [past, expired.id],
    );
    expect((await resolve(s.headers, codeOf(expired))).out.reason).toBe('expired');
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      kit.clock.now(),
      expired.id,
    ]);
    expect((await resolve(s.headers, codeOf(expired))).out.reason).toBe('removed');
  });

  it('not_yet_valid and ended for the pass window', async () => {
    const s = await door();
    const soon = await kit.scanPass(tpl, {
      startsAt: new Date(kit.clock.now() + HOUR).toISOString(),
    });
    const late = await kit.scanPass(tpl, {
      endsAt: new Date(kit.clock.now() - HOUR).toISOString(),
    });
    expect((await resolve(s.headers, codeOf(soon))).out).toMatchObject({
      kind: 'heads_up',
      reason: 'not_yet_valid',
      at: kit.clock.now() + HOUR,
    });
    expect((await resolve(s.headers, codeOf(late))).out).toMatchObject({
      kind: 'heads_up',
      reason: 'ended',
    });
  });

  it('not_yet_valid and ended for the event window; a closed event still answers', async () => {
    const pass = await kit.scanPass(tpl);
    const early = await kit.event({
      templateIds: [tpl],
      opensAt: kit.clock.now() + HOUR,
      closesAt: kit.clock.now() + 2 * HOUR,
    });
    const over = await kit.event({
      templateIds: [tpl],
      opensAt: kit.clock.now() - 2 * HOUR,
      closesAt: kit.clock.now() - HOUR,
    });
    const a = await kit.scanner({ eventId: early.id });
    const b = await kit.scanner({ eventId: over.id });
    expect((await resolve(a.headers, codeOf(pass))).out).toMatchObject({
      reason: 'not_yet_valid',
      at: kit.clock.now() + HOUR,
    });
    expect((await resolve(b.headers, codeOf(pass))).out).toMatchObject({
      reason: 'ended',
      at: kit.clock.now() - HOUR,
    });
  });

  it('check_required for a stop flag, with the card and the flag label', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl, { tier: 'overdue' });
    const { out } = await resolve(s.headers, codeOf(pass));
    expect(out).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Unpaid dues'],
    });
    expect(out.card?.flags).toEqual([{ label: 'Unpaid dues', tone: 'warning', stop: true }]);
  });

  it('an unassigned scanner reads nothing: not_accepted, and its session says unassigned', async () => {
    const s = await door([]);
    const pass = await kit.scanPass(tpl);
    expect((await resolve(s.headers, codeOf(pass))).out).toMatchObject({
      kind: 'refused',
      reason: 'not_accepted',
    });
    const session = (await (await kit.get(s.headers, '/session')).json()) as { state: string };
    expect(session.state).toBe('unassigned');
  });
});

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
    await run(kit.env.DB, 'UPDATE passes SET barcode_hash = ? WHERE id = ?', [
      await sha256Hex(barcode),
      pass.id,
    ]);
    const { out } = await resolve(s.headers, { code: `${barcode}\n`, method: 'wedge' });
    expect(out.card?.passId).toBe(pass.id);
  });

  it('a typed member number finds the pass by lookup hash', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl, { memberNo: 'GYM-0042' });
    await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ? WHERE id = ?', [
      await sha256Hex(normalizeLookup('GYM-0042')),
      pass.id,
    ]);
    expect(
      (await resolve(s.headers, { code: 'gym 0042', method: 'manual' })).out.card?.passId,
    ).toBe(pass.id);
  });

  it('only a manual read may use the serial, external id or pass id', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
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
});

describe('resolve: the card', () => {
  it('has no barcode, nfc, token, URL, serial or readable email', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl, {}, { holderEmail: 'anna.popescu@example.com' });
    const { out } = await resolve(s.headers, codeOf(pass));
    const text = JSON.stringify(out.card);
    for (const word of [
      'barcodes',
      '"barcode"',
      '"nfc"',
      'authenticationToken',
      'webServiceURL',
      'serialNumber',
      'anna.popescu@example.com',
      pass.serial,
      pass.scanCode ?? 'x',
    ])
      expect(text).not.toContain(word);
    const pj = out.card?.passView.passJson as Record<string, unknown>;
    expect(pj).not.toHaveProperty('barcodes');
    expect(out.card?.passView.assetNames).toContain('icon.png');
  });

  it('door state and last scans come from the gates and the scans table', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    expect((await resolve(s.headers, codeOf(pass))).out.card?.door).toEqual({ state: null });
    await kit.post(s.headers, '/actions', { ...body(codeOf(pass)), actionId: 'auto' });
    const card = (await resolve(s.headers, codeOf(pass))).out.card;
    expect(card?.door).toEqual({ state: 'in' });
    expect(card?.actions[0]).toMatchObject({ available: false, reason: 'already_done' });
    expect(card?.lastScans).toHaveLength(1);
  });
});

describe('resolve: tenant isolation', () => {
  it("org B's code, barcode, member number, pass id and asset look like a random code", async () => {
    const orgB = await makeOrg(kit.fx, { name: 'Other Gym' });
    const tplB = await kit.scanTemplate(
      'Gym card',
      { actions: [CHECK_IN], lookup: { input: 'memberNo' } },
      { orgId: orgB.id },
    );
    const passB = await kit.scanPass(tplB, { memberNo: 'B-77' }, { orgId: orgB.id });
    await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ? WHERE id = ?', [
      await sha256Hex(normalizeLookup('B-77')),
      passB.id,
    ]);
    const a = await door();
    const random = mask((await resolve(a.headers, { code: 'ZZZZ-9999', method: 'manual' })).out);
    const inputs = [
      { code: passB.scanCode ?? '', method: 'camera' },
      { code: passB.scanCode ?? '', method: 'manual' },
      { code: 'B 77', method: 'manual' },
      { passId: passB.id, method: 'manual' },
    ];
    for (const input of inputs) {
      const { status, out } = await resolve(a.headers, input);
      expect(status).toBe(200);
      expect(mask(out)).toEqual(random);
    }
    const asset = await kit.get(
      a.headers,
      `/passes/${passB.id}/assets/icon.png?g=${'A'.repeat(54)}`,
    );
    expect(asset.status).toBe(404);
    const unknown = await kit.get(a.headers, `/passes/nope/assets/icon.png?g=${'A'.repeat(54)}`);
    const problem = async (r: Response) => ({ ...((await r.json()) as object), requestId: null });
    expect(await problem(asset)).toEqual(await problem(unknown));
  });
});

describe('asset grant', () => {
  it('serves the image for the actor it was minted for, not for another scanner or after an hour', async () => {
    const s = await door();
    const other = await door();
    const pass = await kit.scanPass(tpl);
    const before = await first<{ n: number }>(kit.env.DB, 'SELECT COUNT(*) AS n FROM scans');
    const { out } = await resolve(s.headers, codeOf(pass));
    const view = out.card?.passView;
    const url = `${view?.assetBaseUrl}icon.png?g=${view?.assetGrant}`.replace('/api/v1/scan', '');
    const ok = await kit.get(s.headers, url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect((await kit.get(other.headers, url)).status).toBe(404);
    const forged = url.replace(/g=(.)/, (_, c: string) => `g=${c === 'A' ? 'B' : 'A'}`);
    expect((await kit.get(s.headers, forged)).status).toBe(404);
    const after = await first<{ n: number }>(kit.env.DB, 'SELECT COUNT(*) AS n FROM scans');
    expect(after?.n).toBe(before?.n);
    kit.clock.advance(HOUR + 1);
    expect((await kit.get(s.headers, url)).status).toBe(404);
  });
});

describe('admin scope', () => {
  const scope = (over: Record<string, unknown> = {}) => ({
    orgId: kit.org.id,
    templateIds: [tpl],
    timeZone: 'UTC',
    ...over,
  });

  it('needs a scope; the org must exist; the mode comes from the header', async () => {
    const pass = await kit.scanPass(tpl);
    const testPass = await kit.scanPass(tpl, {}, { mode: 'test' });
    const send = (headers: Record<string, string>, input: unknown, s?: unknown) =>
      kit.post(headers, '/resolve', { ...body(input), ...(s ? { scope: s } : {}) });
    expect((await send(kit.admin(), codeOf(pass))).status).toBe(422);
    expect((await send(kit.admin(), codeOf(pass), scope({ orgId: 'nope' }))).status).toBe(404);
    const live = (await (await send(kit.admin(), codeOf(pass), scope())).json()) as ScanOutcome;
    expect(live.kind).toBe('ready');
    const asTest = (await (await send(kit.admin(), codeOf(pass), scope())).json()) as ScanOutcome;
    expect(asTest.kind).toBe('ready');
    const testHeaders = { ...kit.admin(), 'x-passbook-mode': 'test' };
    const mismatch = (await (await send(testHeaders, codeOf(pass), scope())).json()) as ScanOutcome;
    expect(mismatch.reason).toBe('live_pass');
    const hit = (await (await send(testHeaders, codeOf(testPass), scope())).json()) as ScanOutcome;
    expect(hit.kind).toBe('ready');
  });
});

describe('session', () => {
  it('describes the scanner, its templates, formats, counts and the csrf token', async () => {
    const s = await door();
    const res = await kit.get(s.headers, '/session');
    const session = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(session).toMatchObject({ principal: 'scanner', state: 'ready', formats: ['qr'] });
    expect(session.scanner).toMatchObject({
      orgName: 'Test Gym',
      mode: 'live',
      deviceRole: 'scan',
    });
    expect(session.templates[0]).toMatchObject({
      id: tpl,
      name: 'Gym card',
      actions: [{ id: 'check_in' }],
    });
    expect(session.csrfToken).toEqual(expect.any(String));
    expect(session.counts).toMatchObject({ today: 0, event: null, configRev: expect.any(Number) });
  });

  it('says staff_required, not_open and closed', async () => {
    const staffed = await door([tpl], { settings: { staffSignIn: true } });
    const get = async (h: Record<string, string>) =>
      ((await (await kit.get(h, '/session')).json()) as { state: string }).state;
    expect(await get(staffed.headers)).toBe('staff_required');
    const early = await kit.event({
      templateIds: [tpl],
      opensAt: kit.clock.now() + HOUR,
      closesAt: kit.clock.now() + 2 * HOUR,
    });
    const over = await kit.event({
      templateIds: [tpl],
      opensAt: kit.clock.now() - 2 * HOUR,
      closesAt: kit.clock.now() - HOUR,
    });
    expect(await get((await kit.scanner({ eventId: early.id })).headers)).toBe('not_open');
    expect(await get((await kit.scanner({ eventId: over.id })).headers)).toBe('closed');
  });
});

describe('misses', () => {
  it('the 31st not_found in ten minutes is 429 SCAN_TOO_MANY_MISSES, audited once', async () => {
    const s = await door();
    let last = 200;
    for (let i = 0; i < 31; i++)
      last = (
        await kit.post(s.headers, '/resolve', body({ code: `MISS-${i}-ZZZZ`, method: 'camera' }))
      ).status;
    expect(last).toBe(429);
    await kit.post(s.headers, '/resolve', body({ code: 'MISS-X-ZZZZ', method: 'camera' }));
    const rows = await all<{ action: string }>(
      kit.env.DB,
      "SELECT action FROM audit_log WHERE action = 'scan.misses_capped' AND actor_id = ?",
      [s.id],
    );
    expect(rows).toHaveLength(1);
  });
});
