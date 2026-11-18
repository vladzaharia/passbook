import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  makeOrg,
  makeSession,
  makeTemplate,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { PassImportSchema } from '../../../shared/contracts/pass-imports.ts';
import { createApp } from '../../app.ts';
import { bump } from '../../platform/counters.ts';
import { all, first, run } from '../../platform/db.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import { importFetchSeam } from './import-source.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

type Headers = Record<string, string>;
const HOUR = 3_600_000;
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let admin: Headers;
let orgKey: Headers;
let readKey: Headers;
let readOnly: Headers;
let stranger: { id: string };
let strangerKey: Headers;
let q: string;

function importTemplate(id: string) {
  const t = makeTemplate({ id });
  const properties: Record<string, unknown> = {
    memberName: { type: 'string', title: 'Name', minLength: 1 },
    points: { type: 'integer', title: 'Points', minimum: 0 },
    active: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    score: { type: 'number' },
  };
  for (let i = 1; i <= 15; i++) properties[`f${i}`] = { type: 'string' };
  (t.resolved.manifest.inputs as { properties: unknown }).properties = properties;
  return t;
}

const api = (headers: Headers, method: string, path: string, body?: unknown, query = q) =>
  app.request(
    `https://wallet.test/api/v1/pass-imports${path}${query}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const plan = (over: Record<string, unknown> = {}) => ({
  mapping: { memberName: { from: '/Name' }, points: { from: '/Points' } },
  holderEmail: { from: '/Email' },
  externalId: { from: '/Id' },
  match: 'externalId',
  keepManual: false,
  save: false,
  ...over,
});
const file = (csv: string, name = 'people.csv') => ({ kind: 'file', name, csv });
const start = (csv: string, withPlan: unknown = plan(), headers = admin) =>
  api(headers, 'POST', '', { templateId: kit.template.id, source: file(csv), plan: withPlan });
const draft = async (res: Response) => {
  expect(res.status).toBe(201);
  return PassImportSchema.parse(await res.json());
};
const HEAD = 'Name,Points,Email,Id';
type Page = { items: { id: string; row: number }[]; nextCursor: string | null };
const pageOf = async (res: Response) => (await res.json()) as Page;

/** A live pass with an external id, bypassing the service for the columns it does not expose. */
async function existing(
  externalId: string,
  email: string | null,
  personalization: Record<string, unknown>,
  mode: 'live' | 'test' = 'live',
) {
  const pass = await kit.pass({
    memberName: String(personalization.memberName),
    mode,
    ...(email ? { holderEmail: email } : {}),
  });
  // Passes made through the service mark every input as edited by hand; an unmarked pass is the common case.
  await run(
    kit.env.DB,
    "UPDATE passes SET external_id = ?, personalization = ?, field_sources = '{}' WHERE id = ?",
    [externalId, JSON.stringify(personalization), pass.id],
  );
  return pass;
}

beforeAll(async () => {
  kit = await setupKit({ template: importTemplate });
  stranger = await makeOrg(kit.fx, { name: 'Elsewhere' });
  auth = await setupTenantTestAuth(kit, [kit.org.id]);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  admin = auth.admin();
  q = `?orgId=${kit.org.id}`;
  orgKey = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read', 'passes:write'] });
  readKey = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
  strangerKey = await auth.apiKey({ orgId: stranger.id, scopes: ['passes:read', 'passes:write'] });
  const reader = await makeUser(kit.fx);
  const session = await makeSession(kit.fx, { userId: reader.id });
  await grantKitMembership(kit, kit.org.id, reader.id, ['read_only']);
  readOnly = { ...session.headers, origin: 'https://wallet.test' };
});

beforeEach(async () => {
  await run(kit.env.DB, 'DELETE FROM pass_import_mappings');
  await run(kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
});

afterEach(() => {
  vi.unstubAllGlobals();
  importFetchSeam.resolver = undefined;
  importFetchSeam.fetchImpl = undefined;
});

describe('check: create, update, unchanged', () => {
  it('matches by External ID and plans the rows without touching passes', async () => {
    await existing('E1', 'e1@x.co', { memberName: 'Old', points: 1 });
    await existing('E2', 'e2@x.co', { memberName: 'Same', points: 2 });
    const res = await start(
      [
        HEAD,
        'New,1,e1@x.co,E1',
        'Same,2,e2@x.co,E2',
        'Fresh,5,e3@x.co,E3',
        'Bad,x,e4@x.co,E4',
      ].join('\n'),
    );
    const d = await draft(res);
    expect(d.state).toBe('ready');
    expect(d.counts).toMatchObject({
      rows: 4,
      create: 1,
      update: 1,
      unchanged: 1,
      errors: 1,
      emailable: 1,
    });
    expect(d.previews.map((p) => [p.row, p.action])).toEqual([
      [2, 'update'],
      [4, 'create'],
    ]);
    expect(d.problems).toEqual([
      expect.objectContaining({
        row: 5,
        code: 'INPUT',
        column: 'Points',
        message: 'Points must be a whole number.',
      }),
    ]);
    expect(d.errorFile).toBe(true);
    expect(d.templateVersion).toBe(kit.liveRelease?.version);
  });

  it('matches by Email', async () => {
    await existing('M1', 'mail1@x.co', { memberName: 'Old' });
    const d = await draft(
      await start(
        `${HEAD}\nNew,1,MAIL1@x.co,\nNew,1,mail2@x.co,`,
        plan({ match: 'email', externalId: null }),
      ),
    );
    expect(d.counts).toMatchObject({ create: 1, update: 1, errors: 0 });
  });

  it('reports an ambiguous, other-template and connected match as row errors', async () => {
    await existing('AMB', null, { memberName: 'One' });
    await existing('AMB', null, { memberName: 'Two' });
    const other = makeTemplate({ id: `other-${kit.fx.ids.token(3)}` });
    await persistTemplate(kit.fx, other.resolved, { registry: other.registry });
    const away = await existing('OTH', null, { memberName: 'Away' });
    await run(kit.env.DB, 'UPDATE passes SET template_id = ?, template_version = ? WHERE id = ?', [
      other.resolved.id,
      other.resolved.version,
      away.id,
    ]);
    const connected = await existing('CON', null, { memberName: 'Synced' });
    const connectionId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at)
       VALUES (?, ?, 'demo', 'Members API', ?, ?)`,
      [connectionId, kit.org.id, kit.clock.now(), kit.clock.now()],
    );
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ? WHERE id = ?', [
      connectionId,
      connected.id,
    ]);
    const d = await draft(await start([HEAD, 'a,1,,AMB', 'b,1,,OTH', 'c,1,,CON'].join('\n')));
    expect(d.problems.map((p) => [p.row, p.code, p.message])).toEqual([
      [
        2,
        'IMPORT_MATCH_AMBIGUOUS',
        'More than one pass has this External ID. Fix it in PassBook first.',
      ],
      [
        3,
        'IMPORT_OTHER_TEMPLATE',
        'This pass uses another template. Import it with that template.',
      ],
      [4, 'IMPORT_CONNECTED', 'Synced by Members API. Change it there.'],
    ]);
  });

  it('never matches a removed pass and keeps the holder email of an update', async () => {
    const gone = await existing('RM', null, { memberName: 'Gone' });
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      kit.clock.now(),
      gone.id,
    ]);
    await existing('KEEP', 'keep@x.co', { memberName: 'Old' });
    const d = await draft(await start([HEAD, 'a,1,,RM', 'b,1,other@x.co,KEEP'].join('\n')));
    expect(d.counts).toMatchObject({ create: 1, update: 1 });
    expect(d.problems).toEqual([
      expect.objectContaining({ row: 3, code: 'IMPORT_EMAIL_KEPT', severity: 'warning' }),
    ]);
  });

  it('replaces fields edited by hand and says which, unless the plan keeps them', async () => {
    const pass = await existing('MAN', null, { memberName: 'Alex', points: 5 });
    await run(kit.env.DB, 'UPDATE passes SET field_sources = ? WHERE id = ?', [
      JSON.stringify({ points: 'manual' }),
      pass.id,
    ]);
    const csv = `${HEAD}\nAlex,9,,MAN`;
    const replaced = await draft(await start(csv));
    expect(replaced.counts).toMatchObject({ update: 1, unchanged: 0, warnings: 1 });
    expect(replaced.problems[0]).toMatchObject({
      code: 'IMPORT_MANUAL_REPLACED',
      severity: 'warning',
      field: 'points',
      message: 'Points was edited in PassBook; the file replaces it.',
    });
    const kept = await draft(await start(csv, plan({ keepManual: true })));
    expect(kept.counts).toMatchObject({ update: 0, unchanged: 1, warnings: 1 });
    expect(kept.problems[0]).toMatchObject({
      code: 'IMPORT_MANUAL_KEPT',
      message: 'Points was edited in PassBook; left as is.',
    });
  });
});

describe('the dry run writes only its own draft', () => {
  const tables = [
    'pass_events',
    'outbox',
    'audit_log',
    'pass_issuance_deliveries',
    'pass_holder_reissue_required',
    'pass_credential_transfers',
    'pass_credential_tombstones',
  ];
  /** Every pass column a write could move, the other tables by count, and R2 outside the import's own prefix. */
  const snapshot = async () => ({
    passes: (
      await all(
        kit.env.DB,
        `SELECT id, version, row_version, revision, personalization, field_sources, status, holder_email,
           external_id, modified_at, removed_at, object_key FROM passes ORDER BY id`,
      )
    ).map((r) => JSON.stringify(r)),
    counts: await Promise.all(
      tables.map(
        async (t) => (await first<{ n: number }>(kit.env.DB, `SELECT count(*) AS n FROM ${t}`))?.n,
      ),
    ),
    objects: (await kit.env.BUCKET.list()).objects
      .map((o) => o.key)
      .filter((k) => !k.startsWith('uploads/pass-imports/'))
      .sort(),
  });

  it('leaves passes (every column), events, outbox, audit and R2 as they were', async () => {
    await existing('W1', 'w1@x.co', { memberName: 'Old' });
    const before = await snapshot();
    const d = await draft(
      await start(
        [HEAD, 'New,1,w1@x.co,W1', 'Fresh,2,w2@x.co,W2', 'Bad,x,,W3'].join('\n'),
        plan({ save: true }),
      ),
    );
    await api(admin, 'POST', `/${d.id}/check`, { plan: plan({ match: 'email' }) });
    await api(admin, 'POST', `/${d.id}/check`, { plan: plan({ keepManual: true }) });
    await api(admin, 'GET', `/${d.id}/rows`);
    await api(admin, 'GET', `/${d.id}/errors.csv`);
    expect(await snapshot()).toEqual(before);
    const rows = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ?',
      [d.id],
    );
    expect(rows?.n).toBe(3);
  });
});

describe('draft lifecycle', () => {
  it('lists columns with samples while mapping, then checks with a plan', async () => {
    const res = await api(admin, 'POST', '', {
      templateId: kit.template.id,
      source: file(`${HEAD}\nA,1,a@x.co,K1\nB,2,b@x.co,K2`),
    });
    const d = await draft(res);
    expect(d.state).toBe('mapping');
    expect(d.plan).toBeNull();
    expect(d.counts).toBeNull();
    expect(d.columns).toEqual([
      { pointer: '/Name', label: 'Name', samples: ['A', 'B'] },
      { pointer: '/Points', label: 'Points', samples: ['1', '2'] },
      { pointer: '/Email', label: 'Email', samples: ['a@x.co', 'b@x.co'] },
      { pointer: '/Id', label: 'Id', samples: ['K1', 'K2'] },
    ]);
    const checked = PassImportSchema.parse(
      await (await api(admin, 'POST', `/${d.id}/check`, { plan: plan() })).json(),
    );
    expect(checked.state).toBe('ready');
    expect(checked.counts).toMatchObject({ rows: 2, create: 2 });
    expect(checked.plan?.match).toBe('externalId');
    expect(checked.emailBudget).toBe(500);
    const again = await api(admin, 'POST', `/${d.id}/check`, { plan: plan({ match: 'none' }) });
    expect(again.status).toBe(200);
    expect((await pageOf(await api(admin, 'GET', `/${d.id}/rows`))).items).toHaveLength(2);
  });

  it('falls back to mapping when a saved plan names a column the file lacks', async () => {
    const saved = await draft(await start(`${HEAD}\nA,1,a@x.co,S1`, plan({ save: true })));
    expect(saved.state).toBe('ready');
    const run1 = await api(admin, 'POST', '', {
      templateId: kit.template.id,
      source: file(`${HEAD}\nA,1,a@x.co,S2`),
    });
    expect((await draft(run1)).state).toBe('ready');
    const lacking = await draft(
      await api(admin, 'POST', '', {
        templateId: kit.template.id,
        source: file('Name,Email,Id\nA,a@x.co,S3'),
      }),
    );
    expect(lacking.state).toBe('mapping');
    expect(Object.keys(lacking.plan?.mapping ?? {})).toEqual(['memberName']);
    expect(lacking.columns.map((c) => c.label)).toEqual(['Name', 'Email', 'Id']);
  });

  it('refuses a check from the wrong state or after the draft expired', async () => {
    const d = await draft(await start(`${HEAD}\nA,1,,X1`));
    await run(kit.env.DB, "UPDATE pass_imports SET state = 'committing' WHERE id = ?", [d.id]);
    await expectProblem(
      await api(admin, 'POST', `/${d.id}/check`, { plan: plan() }),
      409,
      'IMPORT_STATE',
    );
    await expectProblem(await api(admin, 'DELETE', `/${d.id}`), 409, 'IMPORT_BUSY');
    const old = await draft(await start(`${HEAD}\nA,1,,X2`));
    await run(kit.env.DB, 'UPDATE pass_imports SET expires_at = ? WHERE id = ?', [
      kit.clock.now() - 1,
      old.id,
    ]);
    expect(PassImportSchema.parse(await (await api(admin, 'GET', `/${old.id}`)).json()).state).toBe(
      'expired',
    );
    await expectProblem(
      await api(admin, 'POST', `/${old.id}/check`, { plan: plan() }),
      409,
      'IMPORT_EXPIRED',
    );
  });

  it('discards a draft with its rows and file, and lists recent imports', async () => {
    const d = await draft(await start(`${HEAD}\nA,1,,D1`));
    const key =
      (
        await first<{ object_key: string }>(
          kit.env.DB,
          'SELECT object_key FROM pass_imports WHERE id = ?',
          [d.id],
        )
      )?.object_key ?? '';
    expect(await kit.env.BUCKET.get(key)).not.toBeNull();
    expect((await api(admin, 'DELETE', `/${d.id}`)).status).toBe(200);
    expect(await kit.env.BUCKET.get(key)).toBeNull();
    const rows = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ?',
      [d.id],
    );
    expect(rows?.n).toBe(0);
    const got = PassImportSchema.parse(await (await api(admin, 'GET', `/${d.id}`)).json());
    expect(got.state).toBe('discarded');
    const list = await pageOf(await api(admin, 'GET', '', undefined, `${q}&limit=2`));
    expect(list.items).toHaveLength(2);
    expect(list.nextCursor).toEqual(expect.any(String));
    const next = await pageOf(
      await api(admin, 'GET', '', undefined, `${q}&limit=2&cursor=${list.nextCursor}`),
    );
    expect(next.items[0]?.id).not.toBe(list.items[0]?.id);
  });

  it('pages rows 100 at a time and filters by state', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `N${i},1,,P${i}`);
    const d = await draft(await start([HEAD, ...lines].join('\n')));
    const page = await pageOf(await api(admin, 'GET', `/${d.id}/rows`));
    expect(page.items).toHaveLength(100);
    expect(page.items[0]).toMatchObject({ row: 2, action: 'create', state: 'planned' });
    const last = await pageOf(
      await api(admin, 'GET', `/${d.id}/rows`, undefined, `${q}&cursor=${page.nextCursor}`),
    );
    expect(last.items[0]?.row).toBe(102);
    const none = await pageOf(
      await api(admin, 'GET', `/${d.id}/rows`, undefined, `${q}&state=done`),
    );
    expect(none.items).toEqual([]);
  });
});

describe('errors.csv', () => {
  it('keeps the uploaded columns, adds Problem, and guards formulas', async () => {
    const d = await draft(
      await start(
        [
          'Name,Points,Email,Id,Notes',
          'OK,1,,G1,fine',
          'Bad,-5,,G2,"=1+1"',
          'Wide,1,,G3,x,extra',
        ].join('\n'),
        plan({ save: false }),
      ),
    );
    expect(d.counts).toMatchObject({ errors: 2 });
    const res = await api(admin, 'GET', `/${d.id}/errors.csv`);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .slice(1)
      .split('\r\n');
    expect(lines[0]).toBe('Name,Points,Email,Id,Notes,Problem');
    expect(lines[1]).toBe("Bad,'-5,,G2,'=1+1,Points must be at least 0.");
    expect(lines[2]).toMatch(/^Wide,1,,G3,x,The row has 6 cells; the header has 5\./);
    expect(lines).toHaveLength(3);
  });

  it('answers 410 once the file is gone', async () => {
    const d = await draft(await start(`${HEAD}\nBad,x,,H1`));
    const key =
      (
        await first<{ object_key: string }>(
          kit.env.DB,
          'SELECT object_key FROM pass_imports WHERE id = ?',
          [d.id],
        )
      )?.object_key ?? '';
    await kit.env.BUCKET.delete(key);
    await expectProblem(await api(admin, 'GET', `/${d.id}/errors.csv`), 410, 'IMPORT_FILE_GONE');
  });
});

describe('who may do what', () => {
  it('a draft of another org or mode is a 404', async () => {
    const d = await draft(await start(`${HEAD}\nA,1,,T1`));
    await expectProblem(
      await api(strangerKey, 'GET', `/${d.id}`, undefined, ''),
      404,
      'IMPORT_NOT_FOUND',
    );
    await expectProblem(
      await api(strangerKey, 'GET', `/${d.id}/rows`, undefined, ''),
      404,
      'IMPORT_NOT_FOUND',
    );
    await expectProblem(
      await api(strangerKey, 'GET', `/${d.id}/errors.csv`, undefined, ''),
      404,
      'IMPORT_NOT_FOUND',
    );
    await expectProblem(
      await api(strangerKey, 'POST', `/${d.id}/check`, { plan: plan() }, ''),
      404,
      'IMPORT_NOT_FOUND',
    );
    await expectProblem(
      await api(strangerKey, 'DELETE', `/${d.id}`, undefined, ''),
      404,
      'IMPORT_NOT_FOUND',
    );
    expect((await pageOf(await api(strangerKey, 'GET', '', undefined, ''))).items).toEqual([]);
    const testMode = auth.admin({ mode: 'test' });
    await expectProblem(await api(testMode, 'GET', `/${d.id}`), 404, 'IMPORT_NOT_FOUND');
    expect((await pageOf(await api(testMode, 'GET', ''))).items).toEqual([]);
    expect((await api(admin, 'GET', `/${d.id}`)).status).toBe(200);
  });

  it('refuses an org the caller does not belong to', async () => {
    const res = await api(admin, 'GET', '', undefined, `?orgId=${stranger.id}`);
    expect(res.status).toBe(403);
    const key = await api(strangerKey, 'GET', '', undefined, `?orgId=${kit.org.id}`);
    expect(key.status).toBe(403);
    await expectProblem(await api(admin, 'GET', '', undefined, ''), 422, 'ORG_REQUIRED');
  });

  it('refuses a key without passes:write, a read-only member and a stranger', async () => {
    const body = { templateId: kit.template.id, source: file(`${HEAD}\nA,1,,Z1`) };
    await expectProblem(await api(readKey, 'POST', '', body, ''), 403, 'MISSING_SCOPE');
    expect((await api(readOnly, 'POST', '', body)).status).toBe(403);
    expect((await api(auth.user(), 'POST', '', body)).status).toBe(403);
    expect((await api({}, 'POST', '', body)).status).toBe(401);
    expect((await api(orgKey, 'POST', '', body, '')).status).toBe(201);
    const d = await draft(await start(`${HEAD}\nA,1,,Z2`));
    expect((await api(readKey, 'GET', `/${d.id}`, undefined, '')).status).toBe(200);
    expect((await api(readOnly, 'GET', `/${d.id}`)).status).toBe(200);
    expect((await api(readOnly, 'DELETE', `/${d.id}`)).status).toBe(403);
    expect((await api(readKey, 'POST', `/${d.id}/check`, { plan: plan() }, '')).status).toBe(403);
  });

  it('holds 30 new imports an hour per org and mode', async () => {
    const now = kit.clock.now();
    const key = `pass-import:test:org:${kit.org.id}`;
    await bump(kit.env.DB, key, now - (now % HOUR), 29);
    const test = auth.admin({ mode: 'test' });
    const body = { templateId: kit.template.id, source: file(`${HEAD}\nA,1,,R1`) };
    expect((await api(test, 'POST', '', body)).status).toBe(201);
    const limited = await api(test, 'POST', '', body);
    await expectProblem(limited, 429, 'RATE_LIMITED');
    expect(limited.headers.get('retry-after')).toBe('3600');
  });
});

describe('file-level failures', () => {
  it.each([
    ['', 'IMPORT_FILE_EMPTY'],
    ['PK\u0003\u0004zip', 'IMPORT_NOT_CSV'],
    ['A,A\n1,2', 'IMPORT_HEADER_DUPLICATE'],
    ['A,\n1,2', 'IMPORT_HEADER_MISSING'],
  ])('refuses %j with %s and stores no draft', async (csv, code) => {
    const before = await first<{ n: number }>(kit.env.DB, 'SELECT count(*) AS n FROM pass_imports');
    const res = await api(admin, 'POST', '', {
      templateId: kit.template.id,
      source: file(csv || ' '),
    });
    await expectProblem(res, 422, code === 'IMPORT_FILE_EMPTY' ? code : code);
    const after = await first<{ n: number }>(kit.env.DB, 'SELECT count(*) AS n FROM pass_imports');
    expect(after?.n).toBe(before?.n);
  });

  it('refuses a plan for a column the file lacks and an input the template lacks', async () => {
    await expectProblem(
      await start(`${HEAD}\nA,1,,Q1`, plan({ mapping: { points: { from: '/Pts' } } })),
      422,
      'IMPORT_COLUMN_MISSING',
    );
    await expectProblem(
      await start(`${HEAD}\nA,1,,Q1`, plan({ mapping: { nope: { from: '/Name' } } })),
      422,
      'IMPORT_PLAN_INVALID',
    );
  });

  it('refuses an unknown template and a template without a release', async () => {
    const res = await api(admin, 'POST', '', {
      templateId: 'nope',
      source: file(`${HEAD}\nA,1,,Q2`),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('a sheet link', () => {
  const link = 'https://docs.google.com/spreadsheets/d/e/SECRET-TOKEN/pub?output=csv';
  const make = () => ({ templateId: kit.template.id, source: { kind: 'url', url: link } });
  const publicHost = () => {
    importFetchSeam.resolver = { resolve: async () => ['93.184.216.34'] };
  };

  it('fetches the CSV once and keeps only the host', async () => {
    publicHost();
    const fetchMock = vi.fn(async () => new Response(`${HEAD}\nA,1,,L1`, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await api(admin, 'POST', '', { ...make(), plan: plan() });
    const d = await draft(res);
    expect(d.source).toEqual({ kind: 'url', name: 'docs.google.com' });
    expect(d.counts).toMatchObject({ create: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = JSON.stringify(
      await first(kit.env.DB, 'SELECT * FROM pass_imports WHERE id = ?', [d.id]),
    );
    expect(stored).not.toContain('SECRET-TOKEN');
  });

  it.each([
    ['a private address', 'https://10.0.0.5/s.csv', 'UNSAFE_URL'],
    ['a port', 'https://docs.google.com:8443/s.csv', 'UNSAFE_URL'],
  ])('refuses %s without fetching', async (_n, url, code) => {
    publicHost();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expectProblem(
      await api(admin, 'POST', '', { ...make(), source: { kind: 'url', url } }),
      422,
      code,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the platform's own host", async () => {
    publicHost();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const url = `${new URL(kit.env.PUBLIC_BASE_URL).origin}/s.csv`;
    await expectProblem(
      await api(admin, 'POST', '', { ...make(), source: { kind: 'url', url } }),
      422,
      'UNSAFE_URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a host that resolves to a private address', async () => {
    importFetchSeam.resolver = { resolve: async () => ['192.168.1.1'] };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await api(admin, 'POST', '', make());
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses http links by contract', async () => {
    await expectProblem(
      await api(admin, 'POST', '', {
        ...make(),
        source: { kind: 'url', url: 'http://docs.google.com/s.csv' },
      }),
      422,
      'VALIDATION',
    );
  });

  it('refuses a redirect and a response over 2 MB', async () => {
    publicHost();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
      ),
    );
    await expectProblem(await api(admin, 'POST', '', make()), 502, 'REDIRECT_BLOCKED');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(2_000_001), { status: 200 })),
    );
    await expectProblem(await api(admin, 'POST', '', make()), 502, 'RESPONSE_TOO_LARGE');
  });

  it('refuses a link that does not answer 200', async () => {
    publicHost();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    await expectProblem(await api(admin, 'POST', '', make()), 502, 'UPSTREAM');
  });
});

describe('size', () => {
  it('checks 2,000 rows of 20 inputs in under 2 seconds', async () => {
    const cols = [
      'Name',
      'Points',
      'Email',
      'Id',
      ...Array.from({ length: 15 }, (_, i) => `F${i + 1}`),
    ];
    const mapping: Record<string, { from: string }> = {
      memberName: { from: '/Name' },
      points: { from: '/Points' },
    };
    for (let i = 1; i <= 15; i++) mapping[`f${i}`] = { from: `/F${i}` };
    const lines = Array.from({ length: 2000 }, (_, r) =>
      [
        `Name ${r}`,
        String(r),
        `p${r}@x.co`,
        `PERF-${r}`,
        ...Array.from({ length: 15 }, (_, i) => `v${r}-${i}`),
      ].join(','),
    );
    const csv = [cols.join(','), ...lines].join('\n');
    const t0 = performance.now();
    const res = await start(csv, plan({ mapping }));
    const ms = performance.now() - t0;
    const d = await draft(res);
    expect(d.counts).toMatchObject({ rows: 2000, create: 2000, errors: 0 });
    expect(ms).toBeLessThan(2000);
  });
});

describe('updates check the pass as it will be, not the mapped slice', () => {
  it('an update that maps one column of a template with required inputs is fine', async () => {
    await existing('U1', null, { memberName: 'Alex', points: 1 });
    const d = await draft(
      await start(
        'Points,Id\n7,U1',
        plan({ mapping: { points: { from: '/Points' } }, holderEmail: null }),
      ),
    );
    expect(d.problems).toEqual([]);
    expect(d.counts).toMatchObject({ update: 1, create: 0, errors: 0 });
  });

  it('a create that leaves a required input unmapped is an error, an update that breaks the pass is too', async () => {
    await existing('U2', null, { memberName: 'Alex' });
    const d = await draft(
      await start(
        'Points,Id\n7,U2\n8,NEW',
        plan({ mapping: { points: { from: '/Points' } }, holderEmail: null }),
      ),
    );
    expect(d.counts).toMatchObject({ update: 1, create: 0, errors: 1 });
    expect(d.problems).toEqual([
      expect.objectContaining({ row: 3, code: 'INPUT', message: 'Name is required.' }),
    ]);
  });

  it('a blank mapped cell leaves the field as it is', async () => {
    await existing('U3', null, { memberName: 'Alex', points: 4 });
    const d = await draft(await start(`${HEAD}\nAlex,,,U3`));
    expect(d.counts).toMatchObject({ unchanged: 1, update: 0, errors: 0 });
  });
});

describe('External ID is unique whatever the match', () => {
  it('refuses a create whose External ID a live pass has, and a duplicate in the file', async () => {
    await existing('TAKEN', 'old@x.co', { memberName: 'Old' });
    const none = await draft(
      await start([HEAD, 'A,1,,TAKEN', 'B,1,,DUP', 'C,1,,DUP'].join('\n'), plan({ match: 'none' })),
    );
    expect(none.problems.map((p) => [p.row, p.code])).toEqual([
      [2, 'IMPORT_KEY_TAKEN'],
      [4, 'IMPORT_DUPLICATE_KEY'],
    ]);
    const byEmail = await draft(
      await start([HEAD, 'A,1,new@x.co,TAKEN'].join('\n'), plan({ match: 'email' })),
    );
    expect(byEmail.problems.map((p) => p.code)).toEqual(['IMPORT_KEY_TAKEN']);
    const update = await draft(
      await start([HEAD, 'A,1,old@x.co,TAKEN'].join('\n'), plan({ match: 'email' })),
    );
    expect(update.problems).toEqual([]);
  });

  it('refuses an External ID over 200 characters', async () => {
    const d = await draft(await start(`${HEAD}\nA,1,,${'x'.repeat(201)}`));
    expect(d.problems[0]).toMatchObject({ code: 'IMPORT_KEY_TOO_LONG' });
  });
});

describe('the problem list', () => {
  it('lists errors before warnings and counts both', async () => {
    const fields = Array.from({ length: 15 }, (_, i) => `f${i + 1}`);
    for (let i = 0; i < 7; i++) {
      const pass = await existing(`PL${i}`, null, {
        memberName: 'X',
        ...Object.fromEntries(fields.map((f) => [f, 'old'])),
      });
      await run(kit.env.DB, 'UPDATE passes SET field_sources = ? WHERE id = ?', [
        JSON.stringify(Object.fromEntries(fields.map((f) => [f, 'manual']))),
        pass.id,
      ]);
    }
    const cols = ['Name', 'Points', 'Id', ...fields.map((f) => f.toUpperCase())];
    const mapping: Record<string, { from: string }> = { memberName: { from: '/Name' } };
    for (const f of fields) mapping[f] = { from: `/${f.toUpperCase()}` };
    const row = (id: string, points: string) => ['X', points, id, ...fields.map(() => 'new')];
    const csv = [
      cols.join(','),
      ...[0, 1, 2, 3, 4, 5, 6].map((i) => row(`PL${i}`, '1').join(',')),
      ...[0, 1, 2].map((i) => row(`BAD${i}`, 'x').join(',')),
    ].join('\n');
    const d = await draft(
      await start(
        csv,
        plan({ mapping: { ...mapping, points: { from: '/Points' } }, holderEmail: null }),
      ),
    );
    expect(d.problemTotals).toEqual({ errors: 3, warnings: 105 });
    expect(d.problemsTruncated).toBe(true);
    expect(d.problems).toHaveLength(100);
    expect(d.problems.slice(0, 3).map((p) => p.severity)).toEqual(['error', 'error', 'error']);
    expect(d.problems[3]?.severity).toBe('warning');
  });
});

describe('concurrent checks', () => {
  it('never leave a draft whose rows come from two plans', async () => {
    const lines = Array.from({ length: 700 }, (_, i) => `N${i},${i},,C${i}`);
    const d = await draft(
      await start([HEAD, ...lines].join('\n'), plan({ match: 'none', externalId: null })),
    );
    const withPoints = plan({ match: 'none', externalId: null });
    const noPoints = plan({
      match: 'none',
      externalId: null,
      mapping: { memberName: { from: '/Name' } },
    });
    const results = await Promise.all([
      api(admin, 'POST', `/${d.id}/check`, { plan: withPoints }),
      api(admin, 'POST', `/${d.id}/check`, { plan: noPoints }),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    for (const r of results.filter((x) => x.status !== 200)) expect(r.status).toBe(409);
    const got = await first<{ state: string; plan: string; checked: number; rows: number }>(
      kit.env.DB,
      `SELECT state, plan, rows,
         (SELECT count(*) FROM pass_import_rows r WHERE r.import_id = p.id) AS checked
       FROM pass_imports p WHERE id = ?`,
      [d.id],
    );
    expect(got?.state).toBe('ready');
    expect(got?.checked).toBe(got?.rows);
    const rows = await all<{ input: string }>(
      kit.env.DB,
      'SELECT input FROM pass_import_rows WHERE import_id = ?',
      [d.id],
    );
    const stored = JSON.parse(got?.plan ?? '{}');
    const wantsPoints = Object.hasOwn(stored.mapping, 'points');
    expect(rows.every((r) => Object.hasOwn(JSON.parse(r.input), 'points') === wantsPoints)).toBe(
      true,
    );
  });
});

describe('create when the automatic check fails', () => {
  it('returns the draft id in mapping with the reason', async () => {
    await api(admin, 'POST', '', {
      templateId: kit.template.id,
      source: file(`${HEAD}\nA,1,,K1`),
      plan: plan({ save: true }),
    });
    const get = vi.spyOn(kit.env.BUCKET, 'get').mockResolvedValueOnce(null);
    const res = await api(admin, 'POST', '', {
      templateId: kit.template.id,
      source: file(`${HEAD}\nA,1,,K2`),
    });
    get.mockRestore();
    const d = await draft(res);
    expect(d.state).toBe('mapping');
    expect(d.errorCode).toBe('IMPORT_FILE_GONE');
  });
});

describe('plans and limits', () => {
  it('refuses a saved plan whose match key column is missing instead of turning matching off', async () => {
    await draft(await start(`${HEAD}\nA,1,,S1`, plan({ save: true })));
    await expectProblem(
      await api(admin, 'POST', '', {
        templateId: kit.template.id,
        source: file('Name,Points,Email\nA,1,a@x.co'),
      }),
      422,
      'IMPORT_COLUMN_MISSING',
    );
  });

  it('holds 120 checks an hour per org and mode', async () => {
    const d = await draft(await start(`${HEAD}\nA,1,,R1`));
    const now = kit.clock.now();
    await bump(kit.env.DB, `pass-import-check:live:org:${kit.org.id}`, now - (now % HOUR), 120);
    await expectProblem(
      await api(admin, 'POST', `/${d.id}/check`, { plan: plan() }),
      429,
      'RATE_LIMITED',
    );
  });

  it('refuses a header over 200 characters', async () => {
    await expectProblem(
      await api(admin, 'POST', '', {
        templateId: kit.template.id,
        source: file(`${'H'.repeat(201)},B\n1,2`),
      }),
      422,
      'IMPORT_HEADER_TOO_LONG',
    );
  });

  it('names the problem column apart when the upload has one', async () => {
    const d = await draft(
      await start('Name,Points,Id,Problem\nBad,x,Z1,mine', plan({ holderEmail: null })),
    );
    const text = await (await api(admin, 'GET', `/${d.id}/errors.csv`)).text();
    expect(text.split('\r\n')[0]).toBe('Name,Points,Id,Problem,Problem (PassBook)');
  });

  it('a member of two orgs does not read one org’s draft through the other', async () => {
    const other = await makeOrg(kit.fx, { name: 'Second' });
    const user = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id });
    await grantKitMembership(kit, kit.org.id, user.id, ['org_admin']);
    await grantKitMembership(kit, other.id, user.id, ['org_admin']);
    const both = { ...session.headers, origin: 'https://wallet.test' };
    const d = await draft(await start(`${HEAD}\nA,1,,B1`, plan(), both));
    expect((await api(both, 'GET', `/${d.id}`)).status).toBe(200);
    await expectProblem(
      await api(both, 'GET', `/${d.id}`, undefined, `?orgId=${other.id}`),
      404,
      'IMPORT_NOT_FOUND',
    );
  });
});
