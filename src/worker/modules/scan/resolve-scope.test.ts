import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { installVersion } from './repo-resolve-test-fixtures.ts';
import {
  body,
  CHECK_IN,
  door,
  HOUR,
  kit,
  mask,
  resolve,
  setupResolveFixture,
  tpl,
} from './resolve-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupResolveFixture);

describe('resolve: tenant isolation', () => {
  it("org B's code, barcode, member number, pass id and asset look like a random code", async () => {
    const orgB = await makeOrg(kit.fx, { name: 'Other Gym' });
    const tplB = await kit.scanTemplate(
      'Gym card',
      { actions: [CHECK_IN], lookup: { input: 'memberNo' } },
      { orgId: orgB.id },
    );
    const passB = await kit.scanPass(tplB, { memberNo: 'B-77' }, { orgId: orgB.id });
    await run(kit.env.DB, 'UPDATE passes SET lookup_hash = ?, revision=revision+1 WHERE id = ?', [
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
    expect(mismatch).toMatchObject({
      kind: 'refused',
      reason: 'live_pass',
      scanId: null,
      replay: false,
      action: null,
      card: null,
      template: null,
      display: null,
    });
    expect(JSON.stringify(mismatch)).not.toContain(pass.id);
    expect(JSON.stringify(mismatch)).not.toContain('Gym card');
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

describe('resolve: projection revalidation', () => {
  it.each(['pass', 'snapshot', 'scanner', 'template'] as const)(
    'does not disclose a card when %s changes after the card read',
    async (change) => {
      const templateId = await kit.scanTemplate('Resolve race', { actions: [CHECK_IN] });
      const pass = await kit.scanPass(
        templateId,
        { memberName: 'Resolve Private Person' },
        { holderEmail: 'resolve-private@example.test' },
      );
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const real = kit.env.DB;
      const cardStatements = new WeakSet<D1PreparedStatement>();
      let raced = false;
      const db = new Proxy(real, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.includes('SELECT action_id, scope, state, last_at FROM scan_gates'))
                return statement;
              return new Proxy(statement, {
                get(inner, member) {
                  if (member === 'bind')
                    return (...params: unknown[]) => {
                      const bound = inner.bind(...params);
                      cardStatements.add(bound);
                      return bound;
                    };
                  const value = Reflect.get(inner, member, inner);
                  return typeof value === 'function' ? value.bind(inner) : value;
                },
              });
            };
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              if (!raced && statements.some((statement) => cardStatements.has(statement))) {
                raced = true;
                if (change === 'pass')
                  await run(
                    target,
                    'UPDATE passes SET link_generation=link_generation+1 WHERE id=?',
                    [pass.id],
                  );
                else if (change === 'snapshot')
                  await run(
                    target,
                    "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.voided',json('true')) WHERE pass_id=?",
                    [pass.id],
                  );
                else if (change === 'scanner')
                  await run(target, "UPDATE scanners SET device_role='monitor' WHERE id=?", [
                    scanner.id,
                  ]);
                else {
                  const base = await kit.registry.resolve(templateId);
                  await installVersion(
                    templateId,
                    'v2',
                    structuredClone(base.manifest),
                    base.passJson,
                    'new-build',
                  );
                }
              }
              return result;
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(kit.env, { DB: db });
      let response: { status: number; out: ScanOutcome };
      try {
        response = await resolve(scanner.headers, codeOf(pass));
      } finally {
        Object.assign(kit.env, { DB: real });
      }
      expect(raced).toBe(true);
      expect(response).toMatchObject({
        status: 200,
        out: {
          kind: 'refused',
          reason: 'not_found',
          scanId: null,
          card: null,
          display: null,
          template: null,
          previous: null,
          counts: { today: 0, event: null, asOf: 0, configRev: 0 },
        },
      });
      const text = JSON.stringify(response.out);
      for (const secret of [
        pass.id,
        pass.serial,
        pass.scanCode!,
        'Resolve Private Person',
        'resolve-private@example.test',
      ])
        expect(text).not.toContain(secret);
      expect(await all(real, 'SELECT id FROM scans WHERE pass_id=?', [pass.id])).toHaveLength(0);
      expect(
        await all(real, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
          pass.id,
        ]),
      ).toHaveLength(0);
      expect(
        await all(real, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
      ).toHaveLength(0);
    },
  );
});
