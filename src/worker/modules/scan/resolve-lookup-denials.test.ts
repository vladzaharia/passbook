import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { type ScanKit, setupScanKit, startScanCredentialTransfer } from './test-kit.ts';

/*
 * The denial matrix of the pass-bearing reads: each state that must stop a card or a lookup item,
 * driven before the request, each with its positive control (the same request answers while the
 * pass and the scanner are as they were). Races at the final fence are in `resolve-lookup-races`.
 */

let kit: ScanKit;
let templateId: string;
let otherTemplateId: string;
let counter = 0;
const NAME = 'Denial Matrix Member';

beforeAll(async () => {
  kit = await setupScanKit();
  const actions = [{ id: 'check_in', label: 'Check in', kind: 'check_in' as const }];
  templateId = await kit.scanTemplate('Denial matrix', { actions });
  otherTemplateId = await kit.scanTemplate('Denial matrix elsewhere', { actions });
});

const resolveOf = async (headers: Record<string, string>, code: string) => {
  const response = await kit.post(headers, '/resolve', {
    idempotencyKey: `01a1e9f0-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`,
    input: { code, method: 'camera' },
    clientTs: kit.clock.now(),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
};
const lookupOf = async (headers: Record<string, string>, q: string) => {
  const response = await kit.post(headers, '/lookup', { q });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
};

async function subject(
  options: { mode?: 'live' | 'test'; orgId?: string; template?: string } = {},
) {
  const pass = await kit.scanPass(
    options.template ?? templateId,
    { memberName: NAME },
    {
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.orgId ? { orgId: options.orgId } : {}),
    },
  );
  return pass;
}

/** The card and the lookup item answer for this pass under these headers. */
async function answers(headers: Record<string, string>, pass: Pass, lookupQuery = pass.id) {
  const resolved = await resolveOf(headers, pass.scanCode!);
  const found = await lookupOf(headers, lookupQuery);
  return {
    card: resolved.body.card?.passId === pass.id,
    resolved,
    item: (found.body.items as { passId: string }[] | undefined)?.some((i) => i.passId === pass.id),
    found,
  };
}

function expectDenied(
  denied: Awaited<ReturnType<typeof answers>>,
  pass: Pass,
  reason: string | null = 'not_found',
) {
  expect(denied.card).toBe(false);
  expect(denied.item).toBe(false);
  expect(denied.resolved.status).toBe(200);
  if (reason)
    expect(denied.resolved.body).toMatchObject({ kind: 'refused', reason, display: null });
  for (const text of [denied.resolved.text, denied.found.text]) {
    expect(text).not.toContain(pass.id);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain('member.png');
  }
}

describe('resolve and lookup denials', () => {
  it('positive control: the scanner reads its own pass', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await subject();
    const control = await answers(scanner.headers, pass);
    expect(control.card).toBe(true);
    expect(control.item).toBe(true);
  });

  it('another org: nothing, however it is asked', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const other = await makeOrg(kit.fx);
    const foreign = await kit.scanTemplate(
      'Foreign',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      { orgId: other.id },
    );
    const pass = await subject({ orgId: other.id, template: foreign });
    const resolvedById = await kit.post(scanner.headers, '/resolve', {
      idempotencyKey: `01a1e9f0-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`,
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(await resolvedById.json()).toMatchObject({ kind: 'refused', reason: 'not_found' });
    expectDenied(await answers(scanner.headers, pass), pass);
  });

  it('the other mode: a warning without a pass, never a card or an item', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await subject({ mode: 'test' });
    expectDenied(await answers(scanner.headers, pass), pass, 'test_pass');
  });

  it.each(['event', 'template'] as const)('outside the scanner scope (%s)', async (kind) => {
    const pass = await subject();
    const inScope = await kit.scanner({ templateIds: [templateId] });
    expect((await answers(inScope.headers, pass)).card).toBe(true);
    const scanner =
      kind === 'event'
        ? await kit.scanner({
            eventId: (await kit.event({ templateIds: [otherTemplateId] })).id,
          })
        : await kit.scanner({ templateIds: [otherTemplateId] });
    expectDenied(await answers(scanner.headers, pass), pass, null);
  });

  it('a scanner revoked before the request is refused at the door', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await subject();
    expect((await answers(scanner.headers, pass)).card).toBe(true);
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      scanner.id,
    ]);
    const resolved = await resolveOf(scanner.headers, pass.scanCode!);
    expect(resolved.status).toBe(401);
    expect((await lookupOf(scanner.headers, pass.id)).status).toBe(401);
    expect(resolved.text).not.toContain(pass.id);
  });

  it('a signed-in staff member disabled before the request is refused', async () => {
    const staff = await kit.staff('door');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
      staffSince: kit.clock.now(),
      staffSeenAt: kit.clock.now(),
    });
    const pass = await subject();
    expect((await answers(scanner.headers, pass)).card).toBe(true);
    await run(kit.env.DB, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
      kit.clock.now(),
      staff.id,
    ]);
    const resolved = await resolveOf(scanner.headers, pass.scanCode!);
    expect(resolved.status).not.toBe(200);
    expect(resolved.text).not.toContain(pass.id);
    expect((await lookupOf(scanner.headers, pass.id)).status).not.toBe(200);
  });

  it.each([
    ['deleted', 'UPDATE passes SET deleted_at=?, revision=revision+1 WHERE id=?', true],
    ['quarantined', 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', false],
    ['template deleted', "UPDATE templates SET status='deleted' WHERE id=?", false],
  ] as const)('a pass %s', async (kind, sql, withNow) => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await subject({
      template:
        kind === 'template deleted'
          ? await kit.scanTemplate('To delete', {
              actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
            })
          : templateId,
    });
    const door =
      kind === 'template deleted' ? await kit.scanner({ templateIds: [pass.templateId] }) : scanner;
    expect((await answers(door.headers, pass)).card).toBe(true);
    await run(
      kit.env.DB,
      sql,
      kind === 'template deleted'
        ? [pass.templateId]
        : withNow
          ? [kit.clock.now(), pass.id]
          : [pass.id],
    );
    expectDenied(
      await answers(door.headers, pass),
      pass,
      kind === 'template deleted' ? null : 'not_found',
    );
  });

  it.each(['voided', 'removed'] as const)(
    'a pass %s is refused with its reason, no card',
    async (kind) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await subject();
      expect((await answers(scanner.headers, pass)).card).toBe(true);
      await run(
        kit.env.DB,
        kind === 'voided'
          ? "UPDATE passes SET status='voided', lifecycle_generation=lifecycle_generation+1 WHERE id=?"
          : 'UPDATE passes SET removed_at=?, lifecycle_generation=lifecycle_generation+1 WHERE id=?',
        kind === 'voided' ? [pass.id] : [kit.clock.now(), pass.id],
      );
      const denied = await answers(scanner.headers, pass);
      expect(denied.card).toBe(false);
      expect(denied.item).toBe(false);
      expect(denied.resolved.body).toMatchObject({ kind: 'refused', reason: kind, card: null });
      expect(denied.found.text).not.toContain(pass.id);
    },
  );

  it('a pending credential transfer', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await subject();
    expect((await answers(scanner.headers, pass)).card).toBe(true);
    await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
      id: kit.fx.ids.id(),
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    expectDenied(await answers(scanner.headers, pass), pass);
  });

  it('a rotated credential: the old code finds nothing, the pass answers to its new one', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await subject();
    expect((await answers(scanner.headers, pass)).card).toBe(true);
    expect((await startScanCredentialTransfer(kit, pass.id)).state).toBe('completed');
    const old = await answers(scanner.headers, pass, pass.scanCode!);
    expect(old.card).toBe(false);
    expect(old.item).toBe(false);
    expect(old.resolved.body).toMatchObject({ kind: 'refused', reason: 'not_found' });
    expect(old.resolved.text).not.toContain(NAME);
    // Control: the pass itself is not gone, only the credential.
    expect((await lookupOf(scanner.headers, pass.id)).body.items).toHaveLength(1);
  });

  it("a keyset that is not this deployment's answers nothing", async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await subject();
    expect((await answers(scanner.headers, pass)).card).toBe(true);
    const original = kit.env.KEK_V1;
    kit.env.KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(31)));
    try {
      const resolved = await resolveOf(scanner.headers, pass.scanCode!);
      expect(resolved.body.card ?? null).toBeNull();
      expect(resolved.text).not.toContain(pass.id);
      const found = await lookupOf(scanner.headers, pass.id);
      expect(found.body.items ?? []).toEqual([]);
    } finally {
      kit.env.KEK_V1 = original;
    }
  });
});
