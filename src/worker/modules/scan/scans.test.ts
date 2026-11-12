import { describe, expect, it } from 'vitest';
import { makeOrg, makeScanner, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import {
  admin,
  codeOf,
  eventId,
  f,
  get,
  items,
  ORIGIN,
  orgId,
  passId,
  post,
  type Rec,
  recordedAction,
  recordedNoMatch,
  scannerFixture,
  scannerId,
  seed,
  staffId,
  template,
  userHeaders,
} from './repo-scans-split-test-fixtures.ts';
import { grantScanMembership, key } from './test-kit.ts';

describe('GET /scans (admin)', () => {
  it('serves proven action and scanner labels with org-scoped template, event and staff names', async () => {
    const ok = await recordedAction(scannerFixture, passId);
    const refused = await seed({
      outcome: 'refused',
      reason: 'voided',
      action_kind: null,
      action_id: null,
      staff_id: null,
      override_of: 'x',
    });
    const res = await get(`?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const rows = await items(res);
    expect(rows.map((r) => r.id)).toEqual([refused.id, ok.id]);
    expect(rows[1]).toMatchObject({
      outcome: 'ok',
      kind: 'check_in',
      actionLabel: 'Let in',
      passTitle: 'Alex Morgan',
      templateName: 'Test template',
      scannerName: expect.stringContaining('Scanner'),
      staffName: 'Dana',
      eventName: 'Event',
      override: false,
      offline: false,
      actor: { type: 'scanner', id: scannerId },
      undoneAt: null,
    });
    expect(rows[0]).toMatchObject({ reason: 'voided', override: true, staffName: null });
  });

  it('filters by org, mode, scanner, staff, event, pass, outcome, reason and time; pages', async () => {
    const other = await makeOrg(f);
    const otherScanner = await makeScanner(f, { orgId: other.id });
    const a = await recordedAction(scannerFixture, passId);
    const b = await seed({ outcome: 'heads_up', reason: 'already_done' });
    const unassigned = await makeScanner(f, { orgId, templateIds: [template.resolved.id] });
    const c = await recordedNoMatch(unassigned);
    await seed({
      org_id: other.id,
      scanner_id: otherScanner.id,
      pass_id: null,
      template_id: null,
      event_id: null,
      staff_id: null,
    });
    await seed({ mode: 'test' });
    const ids = async (q: string, headers = admin()) =>
      (await items(await get(q, headers))).map((r) => r.id);
    expect(await ids(`?orgId=${orgId}`)).toEqual([c.id, b.id, a.id]);
    expect(await ids(`?orgId=${orgId}`, admin('test'))).toHaveLength(1);
    expect(await ids(`?orgId=${orgId}&scannerId=${scannerId}`)).toEqual([a.id]);
    expect(await ids(`?orgId=${orgId}&staffId=${staffId}`)).toEqual([a.id]);
    expect(await ids(`?orgId=${orgId}&eventId=${eventId}`)).toEqual([a.id]);
    expect(await ids(`?orgId=${orgId}&passId=${passId}`)).toEqual([a.id]);
    expect(await ids(`?orgId=${orgId}&outcome=heads_up`)).toEqual([b.id]);
    expect(await ids(`?orgId=${orgId}&reason=not_found`)).toEqual([c.id]);
    expect(await ids(`?orgId=${orgId}&from=${b.at}&to=${b.at}`)).toEqual([b.id]);
    const one = (await (await get(`?orgId=${orgId}&limit=2`)).json()) as {
      items: Rec[];
      nextCursor: string;
    };
    expect(one.items).toHaveLength(2);
    expect(one.nextCursor).toEqual(expect.any(String));
    expect(one.nextCursor).not.toContain(b.id);
    expect(
      await ids(`?orgId=${orgId}&limit=2&cursor=${encodeURIComponent(one.nextCursor)}`),
    ).toEqual([a.id]);
    const tampered = `${one.nextCursor.slice(0, 4)}${one.nextCursor[4] === 'A' ? 'B' : 'A'}${one.nextCursor.slice(5)}`;
    for (const path of [
      `?orgId=${orgId}&cursor=${encodeURIComponent(tampered)}`,
      `?orgId=${orgId}&outcome=ok&cursor=${encodeURIComponent(one.nextCursor)}`,
      `?orgId=${orgId}&cursor=${b.id}`,
    ]) {
      const invalid = await get(path);
      expect(invalid.status).toBe(422);
      expect(await codeOf(invalid)).toBe('INVALID_CURSOR');
    }
    const otherUser = await makeUser(f);
    await grantScanMembership(f, orgId, otherUser.id, ['read_only']);
    const otherHeaders = {
      ...(await makeSession(f, { userId: otherUser.id })).headers,
      origin: ORIGIN,
    };
    const otherCursor = await get(
      `?orgId=${orgId}&cursor=${encodeURIComponent(one.nextCursor)}`,
      otherHeaders,
    );
    expect(otherCursor.status).toBe(422);
    expect(await codeOf(otherCursor)).toBe('INVALID_CURSOR');
    expect(c.id).toBeTruthy();
  });

  it('shows an unknown code as a row with no pass', async () => {
    await recordedNoMatch(scannerFixture);
    const [row] = await items(await get(`?orgId=${orgId}`));
    expect(row).toMatchObject({
      passId: null,
      passTitle: null,
      templateId: null,
      reason: 'not_found',
      actionLabel: null,
    });
  });

  it('shows an undo time and who undid the scan, keeping an unproven undo row minimal', async () => {
    const target = await recordedAction(scannerFixture, passId);
    const response = await post(`/${target.id}/undo`, { idempotencyKey: key() });
    expect(response.status).toBe(200);
    const undo: ScanOutcome = await response.json();
    if (!undo.scanId || undo.at === null)
      throw new Error('A successful undo must have an id and time.');
    const rows = await items(await get(`?orgId=${orgId}`));
    expect(rows.find((r) => r.id === target.id)).toMatchObject({
      undoneAt: undo.at,
      undoneBy: 'Admin console',
    });
    expect(rows.find((r) => r.id === undo.scanId)).toMatchObject({
      kind: null,
      actionLabel: null,
      undoes: null,
      passId: null,
      templateId: null,
    });
  });

  it('requires scanning capability for a signed-in user', async () => {
    expect((await get(`?orgId=${orgId}`, userHeaders)).status).toBe(403);
    expect((await get(`?orgId=${orgId}`, {})).status).toBe(401);
  });
});
