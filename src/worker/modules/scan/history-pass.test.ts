import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { HistoryPage } from '../../../shared/contracts/scan-history.ts';
import { run } from '../../platform/db.ts';
import { DAY, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Visits', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

type Role = 'door' | 'desk';
/** A device of this role, signed in as a named staff member. */
async function device(role: Role, name?: string) {
  const staff = await kit.staff(role, name);
  return kit.scanner({
    templateIds: [templateId],
    staffId: staff.id,
    settings: { staffSignIn: true },
  });
}
const checkIn = async (passId: string, headers: Record<string, string>) => {
  const row = await kit.post(headers, '/actions', {
    input: { passId, method: 'manual' },
    idempotencyKey: key(),
    clientTs: kit.clock.now(),
    actionId: 'enter',
  });
  expect(row.status).toBe(200);
  kit.clock.advance(1000);
  return (await row.json()) as { scanId: string; kind: string };
};
const history = async (passId: string, headers: Record<string, string>, query = '') => {
  const res = await kit.get(headers, `/passes/${passId}/history${query}`);
  return { status: res.status, page: (await res.json()) as HistoryPage };
};
const note = (passId: string, headers: Record<string, string>, text: string) =>
  kit.post(headers, `/passes/${passId}/notes`, { body: text, idempotencyKey: key() });

describe('a person history', () => {
  it('lists visits and notes newest first, with who for Desk and no note text', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk', 'Dana D.');
    const first = await checkIn(pass.id, dana.headers);
    expect(first.kind).toBe('ok');
    expect((await note(pass.id, dana.headers, 'Waiver unsigned')).status).toBe(200);
    kit.clock.advance(1000);
    await checkIn(pass.id, dana.headers);
    const { status, page } = await history(pass.id, dana.headers);
    expect(status).toBe(200);
    expect(page.items.map((i) => i.event)).toEqual(['checked_in', 'note', 'checked_in']);
    expect(page.items[0]).toMatchObject({ label: 'Check in', staff: 'Dana D.' });
    expect(page.items[1]).toMatchObject({ staff: 'Dana D.', label: null });
    expect(JSON.stringify(page)).not.toContain('Waiver');
    expect(page.nextCursor).toBeNull();
  });

  it('shows a Door visits only: no staff, no values, no notes', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk', 'Dana E.');
    const dev = await device('door', 'Dev D.');
    await checkIn(pass.id, dana.headers);
    await note(pass.id, dana.headers, 'Private');
    const { page } = await history(pass.id, dev.headers);
    expect(page.items.map((i) => i.event)).toEqual(['checked_in']);
    expect(page.items[0]).toMatchObject({ staff: null, amount: null });
    expect(JSON.stringify(page)).not.toContain('Dana');
    expect((await history(pass.id, dev.headers, '?filter=changes')).page.items).toEqual([]);
    expect((await kit.get(dev.headers, `/passes/${pass.id}/notes`)).status).toBe(403);
  });

  it('pages by cursor without a repeat or a gap, notes and scans together', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.unshift((await checkIn(pass.id, dana.headers)).scanId);
      await note(pass.id, dana.headers, `n${i}`);
      kit.clock.advance(1000);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const { page } = await history(
        pass.id,
        dana.headers,
        `?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    for (const id of ids) expect(seen).toContain(id);
  });

  it('keeps 30 days and answers the filters', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk');
    const old = await checkIn(pass.id, dana.headers);
    await run(kit.env.DB, 'UPDATE scans SET at = ? WHERE id = ?', [
      kit.clock.now() - 31 * DAY,
      old.scanId,
    ]);
    const recent = await checkIn(pass.id, dana.headers);
    await note(pass.id, dana.headers, 'Hello');
    const all = (await history(pass.id, dana.headers)).page.items;
    expect(all.map((i) => i.id)).not.toContain(old.scanId);
    expect(all.map((i) => i.id)).toContain(recent.scanId);
    expect((await history(pass.id, dana.headers, '?filter=visits')).page.items).toHaveLength(1);
    expect(
      (await history(pass.id, dana.headers, '?filter=changes')).page.items.map((i) => i.event),
    ).toEqual(['note']);
  });

  it('shows an undone check-in as undone, not as a second line', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk');
    const done = await checkIn(pass.id, dana.headers);
    const undo = await kit.post(dana.headers, `/scans/${done.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undo.status).toBe(200);
    const { page } = await history(pass.id, dana.headers);
    expect(page.items.map((i) => i.event)).toEqual(['undone']);
  });

  it('answers a pass of another org, another mode or another template as missing', async () => {
    const dana = await device('desk');
    const other = await makeOrg(kit.fx);
    const foreign = await kit.pass({ orgId: other.id });
    const test = await kit.scanPass(templateId, {}, { mode: 'test' });
    const otherTemplate = await kit.scanTemplate('Else', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    const elsewhere = await kit.scanPass(otherTemplate);
    for (const p of [foreign, test, elsewhere])
      expect((await kit.get(dana.headers, `/passes/${p.id}/history`)).status).toBe(404);
  });

  it('refuses a malformed query and a device that is not a scanner', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk');
    for (const q of ['?cursor=abc', '?limit=0', '?limit=51', '?filter=all%27']) {
      expect((await kit.get(dana.headers, `/passes/${pass.id}/history${q}`)).status).toBe(422);
    }
    const screen = await kit.scanner({ deviceRole: 'customer' });
    expect([401, 403]).toContain(
      (await kit.get(screen.headers, `/passes/${pass.id}/history`)).status,
    );
    expect((await kit.get({}, `/passes/${pass.id}/history`)).status).toBe(401);
  });

  it('reduces a scan whose signed proof does not hold to a time and a result', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk', 'Dana F.');
    await checkIn(pass.id, dana.headers);
    const before = (await history(pass.id, dana.headers)).page.items[0];
    expect(before).toMatchObject({ event: 'checked_in', label: 'Check in', staff: 'Dana F.' });
    await run(
      kit.env.DB,
      "UPDATE pass_events SET data = json_set(data, '$.authority.credentialGeneration', 99) WHERE pass_id = ? AND kind = 'scan.checked_in'",
      [pass.id],
    );
    const after = (await history(pass.id, dana.headers)).page.items[0];
    expect(after).toMatchObject({
      event: 'scanned',
      label: null,
      staff: null,
      amount: null,
      reason: null,
      place: 'Scanner',
    });
  });
});
