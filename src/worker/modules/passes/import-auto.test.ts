import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import starter from '../../../../templates/starter-monthly-pass/wallet.template.json';
import { makeTemplate } from '../../../../test/helpers/index.ts';
import { PassImportSchema } from '../../../shared/contracts/pass-imports.ts';
import { sampleCsv } from '../../../shared/issuing/sample.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { splitInput } from './import-plan.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { setupTenantTestAuth } from './tenant-test-fixtures.ts';

type Headers = Record<string, string>;
function monthly(id: string) {
  const t = makeTemplate({ id });
  const manifest = t.resolved.manifest as unknown as { inputs: unknown; scan?: unknown };
  // kit.pass() creates passes with a name only; the file's own column still feeds memberId.
  manifest.inputs = { ...starter.inputs, required: ['memberName'] };
  manifest.scan = { actions: [], lookup: { input: 'memberId' } };
  return t;
}

let kit: Kit;
let app: ReturnType<typeof createApp>;
let admin: Headers;
let key: Headers;
let q: string;

const api = (headers: Headers, method: string, path: string, body?: unknown, extra: Headers = {}) =>
  app.request(
    `https://wallet.test/api/v1/pass-imports${path}${path.includes('?') ? '&' : '?'}orgId=${kit.org.id}`,
    {
      method,
      headers: {
        ...headers,
        ...extra,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const file = (csv: string) => ({ kind: 'file', name: 'people.csv', csv });
const auto = (csv: string, extra: Headers = {}) =>
  api(
    admin,
    'POST',
    '',
    { templateId: kit.template.id, source: file(csv), mapping: 'auto' },
    extra,
  );
const parse = async (res: Response) => {
  expect(res.status).toBeLessThan(300);
  return PassImportSchema.parse(await res.json());
};

beforeAll(async () => {
  kit = await setupKit({ template: monthly });
  const auth = await setupTenantTestAuth(kit, [kit.org.id]);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  admin = auth.admin();
  key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read', 'passes:write'] });
  q = `?orgId=${kit.org.id}`;
});

beforeEach(async () => {
  await run(kit.env.DB, 'DELETE FROM pass_import_mappings');
  await run(kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
});

const WALKTHROUGH = [
  'Holder email,Member ID,Name,Plan,Paid through',
  'a@x.co,M-1,Ann Lee,Monthly,12/31/2030',
  'b@x.co,M-2,Bo Chen,monthly,01/15/2031',
].join('\n');

describe('mapping: auto', () => {
  it('maps its own sample in full and checks it with no errors', async () => {
    const res = await app.request(
      `https://wallet.test/api/v1/templates/${kit.template.id}/sample.csv${q}`,
      { headers: admin },
      kit.env,
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(`\uFEFF${csv}`).toBe(sampleCsv(starter.inputs));
    const imp = await parse(await auto(csv));
    expect(imp.mapping?.missing).toEqual([]);
    expect(imp.mapping?.unused).toEqual([]);
    expect(imp.counts).toMatchObject({ rows: 1, create: 1, errors: 0 });
    expect(imp.plan?.match).toBe('externalId');
  });

  it('feeds Member ID to both the ID input and External ID, and reads labels and dates', async () => {
    const imp = await parse(await auto(WALKTHROUGH));
    expect(imp.plan?.externalId?.from).toBe('/Member ID');
    expect(imp.plan?.mapping.memberId?.from).toBe('/Member ID');
    expect(imp.plan?.holderEmail?.from).toBe('/Holder email');
    expect(imp.counts).toMatchObject({ create: 2, errors: 0 });
    const rows = await all<{ input: string }>(
      kit.env.DB,
      'SELECT input FROM pass_import_rows WHERE import_id = ? ORDER BY row_no',
      [imp.id],
    );
    expect(JSON.parse(rows[0]?.input ?? '{}')).toMatchObject({
      plan: 'member',
      validUntil: '2030-12-31T00:00:00.000Z',
    });
  });

  it('words an unknown option by its labels and counts the row by intent', async () => {
    const imp = await parse(
      await auto(
        'Holder email,Member ID,Name,Status\na@x.co,M-1,Ann,Gone\nb@x.co,M-2,Bo,suspended',
      ),
    );
    expect(imp.counts).toMatchObject({ create: 1, errors: 1, errorsCreate: 1, errorsUpdate: 0 });
    expect(imp.problems[0]?.message).toBe('Status must be Active or Suspended.');
    expect(imp.problems[0]?.message).not.toMatch(/Gone/);
    expect(imp.problems[0]).toMatchObject({ label: 'Status', field: 'status', value: 'Gone' });
  });
});

describe('overrides', () => {
  it('lays a fix over the cell and re-checks the file', async () => {
    const imp = await parse(
      await auto('Holder email,Member ID,Name,Status\na@x.co,M-1,Ann,Gone\nb@x.co,M-2,Bo,Active'),
    );
    expect(imp.counts?.errors).toBe(1);
    const plan = { ...imp.plan, overrides: { '2': { '/Status': 'Active' } } };
    const fixed = await parse(await api(admin, 'POST', `/${imp.id}/check`, { plan }));
    expect(fixed.counts).toMatchObject({ create: 2, errors: 0 });
  });
});

describe('dates in changes', () => {
  it('read in the org time zone, and in Seattle time when it has none', async () => {
    const pass = await kit.pass({ memberName: 'Old' });
    await run(
      kit.env.DB,
      "UPDATE passes SET external_id = 'TZ-1', personalization = ?, field_sources = '{}' WHERE id = ?",
      [JSON.stringify({ memberName: 'Old', validUntil: '2030-12-31T20:00:00.000Z' }), pass.id],
    );
    const csv = 'Holder email,Member ID,Name,Paid through\na@x.co,TZ-1,Old,2031-01-01 20:00';
    const paid = async () => {
      const imp = await parse(await auto(csv));
      const rows = (await (await api(admin, 'GET', `/${imp.id}/rows`)).json()) as {
        items: { changes?: { key: string; from: string }[] }[];
      };
      return rows.items[0]?.changes?.find((c) => c.key === 'validUntil')?.from;
    };
    expect(await paid()).toBe('Dec 31, 2030, 12:00 PM');
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'org.timeZone', '\"UTC\"', 1)",
      [`org:${kit.org.id}`],
    );
    expect(await paid()).toBe('Dec 31, 2030, 8:00 PM');
    await run(kit.env.DB, "DELETE FROM settings WHERE key = 'org.timeZone'");
  });
});

describe('problem values', () => {
  it('are read from the stored input, so clearing the input clears them', async () => {
    const imp = await parse(
      await auto('Holder email,Member ID,Name,Guests left\na@x.co,M-1,Ann,abc'),
    );
    expect(imp.problems[0]).toMatchObject({ label: 'Guests left', value: 'abc' });
    const stored = await first<{ problems: string }>(
      kit.env.DB,
      'SELECT problems FROM pass_import_rows WHERE import_id = ?',
      [imp.id],
    );
    expect(stored?.problems).not.toContain('"value"');
    // What the 30-day clear does to the row.
    await run(kit.env.DB, 'UPDATE pass_import_rows SET input = NULL WHERE import_id = ?', [imp.id]);
    const got = await parse(await api(admin, 'GET', `/${imp.id}`));
    expect(got.problems[0]?.value).toBeUndefined();
    expect(got.problems[0]?.label).toBe('Guests left');
  });
});

describe('unread cells', () => {
  it('show their text, lose it with the input, and never reach a pass', async () => {
    const imp = await parse(
      await auto('Holder email,Member ID,Name,Status\na@x.co,M-1,Ann,Gone\nb@x.co,M-2,Bo,Active'),
    );
    expect(imp.problems[0]).toMatchObject({ field: 'status', value: 'Gone' });
    const stored = await first<{ input: string }>(
      kit.env.DB,
      'SELECT input FROM pass_import_rows WHERE import_id = ? AND row_no = 2',
      [imp.id],
    );
    expect(JSON.parse(stored?.input ?? '{}').$raw).toEqual({ status: 'Gone' });
    expect(imp.previews.every((p) => !('$raw' in p.input))).toBe(true);
    // Apply reads a row's input through splitInput: the raw cells are not part of it.
    expect(splitInput(stored?.input ?? null).input).not.toHaveProperty('$raw');
    await run(kit.env.DB, 'UPDATE pass_import_rows SET input = NULL WHERE import_id = ?', [imp.id]);
    const cleared = await parse(await api(admin, 'GET', `/${imp.id}`));
    expect(cleared.problems[0]?.value).toBeUndefined();
  });
});

describe('GET /{id}', () => {
  it('carries the suggestion while the draft is being mapped', async () => {
    const imp = await parse(await auto(WALKTHROUGH));
    const got = await parse(await api(admin, 'GET', `/${imp.id}`));
    expect(got.mapping?.fields.find((f) => f.target === 'memberId')?.from).toEqual(['/Member ID']);
  });
});

describe('re-check with a fix', () => {
  it('rewrites only the rows the fix touches and keeps the others as they were', async () => {
    const imp = await parse(
      await auto(
        'Holder email,Member ID,Name,Status\na@x.co,M-1,Ann,Gone\nb@x.co,M-2,Bo,Active\nc@x.co,M-3,Cy,Active',
      ),
    );
    await run(kit.env.DB, "UPDATE pass_import_rows SET code = 'MARK' WHERE import_id = ?", [
      imp.id,
    ]);
    const plan = { ...imp.plan, overrides: { '2': { '/Status': 'Active' } } };
    const fixed = await parse(await api(admin, 'POST', `/${imp.id}/check`, { plan }));
    expect(fixed.counts).toMatchObject({ rows: 3, create: 3, errors: 0 });
    const marks = await all<{ row_no: number; code: string | null }>(
      kit.env.DB,
      'SELECT row_no, code FROM pass_import_rows WHERE import_id = ? ORDER BY row_no',
      [imp.id],
    );
    expect(marks).toEqual([
      { row_no: 2, code: null },
      { row_no: 3, code: 'MARK' },
      { row_no: 4, code: 'MARK' },
    ]);
  });

  it('re-checks a row that shares a key with the fixed one', async () => {
    const imp = await parse(
      await auto('Holder email,Member ID,Name\na@x.co,M-1,Ann\nb@x.co,M-1,Bo'),
    );
    expect(imp.counts?.errors).toBe(1);
    const plan = { ...imp.plan, overrides: { '2': { '/Member ID': 'M-9' } } };
    const fixed = await parse(await api(admin, 'POST', `/${imp.id}/check`, { plan }));
    expect(fixed.counts).toMatchObject({ create: 2, errors: 0 });
  });
});

describe('row changes', () => {
  it('shows an update by labels and what an error row would do', async () => {
    for (const id of ['M-1', 'M-2']) {
      const pass = await kit.pass({ memberName: 'Old' });
      await run(
        kit.env.DB,
        "UPDATE passes SET external_id = ?, personalization = ?, field_sources = '{}' WHERE id = ?",
        [id, JSON.stringify({ memberName: 'Old', memberId: id, plan: 'member' }), pass.id],
      );
    }
    const imp = await parse(
      await auto(
        'Holder email,Member ID,Name,Status\na@x.co,M-1,Ann Lee,Gone\nb@x.co,M-2,Bo Chen,suspended\nz@x.co,M-9,New,Active\nq@x.co,M-8,New,Nope',
      ),
    );
    expect(imp.counts).toMatchObject({
      update: 1,
      create: 1,
      errors: 2,
      errorsUpdate: 1,
      errorsCreate: 1,
    });
    const rows = (await (await api(admin, 'GET', `/${imp.id}/rows`)).json()) as {
      items: {
        row: number;
        action: string;
        wouldBe?: string;
        changes?: { label: string; to: string }[];
      }[];
    };
    const at = (n: number) => rows.items.find((r) => r.row === n);
    expect(at(2)).toMatchObject({ action: 'error', wouldBe: 'update' });
    expect(at(3)?.changes).toEqual([
      { key: 'memberName', label: 'Name', from: 'Old', to: 'Bo Chen' },
      { key: 'status', label: 'Status', from: null, to: 'Suspended' },
    ]);
    expect(at(4)).toMatchObject({ action: 'create' });
    expect(at(2)?.changes).toBeUndefined();
    expect(at(5)).toMatchObject({ action: 'error', wouldBe: 'create' });
  });
});

describe('saved mappings', () => {
  const body = (name: string, columns: string[]) => ({
    templateId: kit.template.id,
    name,
    columns,
    plan: {
      mapping: { memberName: { from: '/Who' } },
      holderEmail: null,
      externalId: { from: '/Num' },
      match: 'externalId',
      keepManual: false,
      save: true,
    },
  });

  it('saves, lists and deletes by name, and picks one by the file columns', async () => {
    const put = await api(
      admin,
      'PUT',
      '/mappings',
      body('Gym export', ['Num', 'Who', 'Plan', 'Until', 'Mail']),
    );
    expect(put.status).toBe(200);
    const list = (await (
      await api(admin, 'GET', `/mappings?templateId=${kit.template.id}`)
    ).json()) as {
      saved: { name: string }[];
    };
    expect(list.saved.map((s) => s.name)).toEqual(['Gym export']);
    const imp = await parse(
      await auto('Num,Who,Plan,Until,Mail\nM-1,Ann,Monthly,2030-01-01,a@x.co'),
    );
    expect(imp.plan?.mapping.memberName?.from).toBe('/Who');
    const del = await api(
      admin,
      'DELETE',
      `/mappings?templateId=${kit.template.id}&name=${encodeURIComponent('Gym export')}`,
    );
    expect(((await del.json()) as { saved: unknown[] }).saved).toEqual([]);
  });

  it('keeps the last plan beside the named ones', async () => {
    await api(admin, 'PUT', '/mappings', body('A', ['Num', 'Who']));
    const imp = await parse(await auto(WALKTHROUGH));
    expect(imp.counts?.errors).toBe(0);
    const list = (await (
      await api(admin, 'GET', `/mappings?templateId=${kit.template.id}`)
    ).json()) as {
      saved: unknown[];
    };
    expect(list.saved).toHaveLength(1);
  });

  it('refuses a read-only key a write', async () => {
    const read = await makeReadKey();
    const res = await api(read, 'PUT', '/mappings', body('X', ['A']));
    expect(res.status).toBe(403);
  });
});

async function makeReadKey(): Promise<Headers> {
  const auth = await setupTenantTestAuth(kit, [kit.org.id]);
  return auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
}

describe('Idempotency-Key', () => {
  const csv = 'Holder email,Member ID,Name\na@x.co,M-1,Ann';
  it('replays the same body and refuses another body under the key', async () => {
    const one = await auto(csv, { 'idempotency-key': 'k1' });
    const two = await auto(csv, { 'idempotency-key': 'k1' });
    expect(two.headers.get('idempotent-replayed')).toBe('true');
    expect(((await two.json()) as { id: string }).id).toBe(
      ((await one.json()) as { id: string }).id,
    );
    const other = await auto(`${csv}\nb@x.co,M-2,Bo`, { 'idempotency-key': 'k1' });
    expect(other.status).toBe(422);
    expect(key).toBeDefined();
  });
});
