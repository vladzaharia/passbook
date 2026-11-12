import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { visibleIdentity } from './card-semantics.ts';
import { cardPrivacy } from './dto-projection.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, body, card, last, manager, simple, stage } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it.each([
    { name: 'PrivateRef', value: 'PrivateRef', field: 'name' },
    { name: 'Style projection', value: 'generic', field: 'style' },
  ] as const)(
    'neutralizes a template $field containing a denied input',
    async ({ name, value, field }) => {
      const templateId = await kit.scanTemplate(name, {
        actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in' }],
      });
      await stage(templateId, 'v1', 'v2', (manifest) => {
        manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager' };
      });
      const pass = await kit.scanPass(templateId, { tier: value });
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const response = await kit.post(scanner.headers, '/resolve', body(pass.id));
      expect(response.status).toBe(200);
      const outcome = (await response.json()) as ScanOutcome;
      expect(outcome.kind).toBe('ready');
      if (!outcome.card) throw new Error('Expected a ready scanner card');
      expect(outcome.card.template.id).toBe(templateId);
      expect(outcome.card.template[field]).toBe('');
      expect(outcome.template?.[field]).toBe('');
      expect(JSON.stringify(outcome.card.template)).not.toContain(value);
      expect(JSON.stringify(outcome.template)).not.toContain(value);
    },
  );

  it.each(['public', 'pinned-restricted'] as const)(
    'selects active identity only through the original %s source policies',
    async (source) => {
      const templateId = await kit.scanTemplate('Active identity', {
        actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in' }],
      });
      await stage(templateId, 'v1', 'v2', (manifest) => {
        manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager' };
      });
      const pass = await kit.scanPass(templateId, { memberNo: 'Public member', tier: 'Gold' });
      await stage(templateId, 'v2', 'v3', (manifest) => {
        manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'door' };
        manifest.display.title = source === 'public' ? '{{memberNo}}' : '{{tier}}';
      });
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const scannerRow = await getScanner(kit.env.DB, scanner.id);
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!scannerRow || !candidate) throw new Error('Missing real card fixture');
      const scope = await readScannerScope(kit.env.DB, scannerRow, null);
      const actor = withRole(
        await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
        null,
      );
      const found = await foundOf(kit.ctx, candidate, actor);
      if (!found) throw new Error('Missing evaluated card fixture');
      const privacy = cardPrivacy(found, actor);
      expect(visibleIdentity(found, actor, privacy).title).toBe('Anna Popescu');
      expect(visibleIdentity(found, actor, privacy, 'active').title).toBe(
        source === 'public' ? 'Public member' : null,
      );
      expect(
        visibleIdentity({ ...found, activeVersion: 'unproved-version' }, actor, privacy, 'active'),
      ).toEqual({ title: null, subtitle: null });
    },
  );

  it('does not expose a contact-bearing action label even when its event is proven', async () => {
    const { pass, scanner } = await simple('private@example.com');
    const scanId = await act(scanner.headers, pass.id);
    const projected = await card(scanner.headers, pass.id);
    expect(projected.lastScans.find((row) => row.scanId === scanId)).toBeUndefined();
    expect(projected.actions.some((action) => action.id === 'enter')).toBe(false);
    expect(JSON.stringify(projected.lastScans)).not.toContain('private@example.com');
  });

  it('does not expose a current action id copied from a role-restricted source', async () => {
    const templateId = await kit.scanTemplate('Private action id', {
      actions: [{ id: 'vip_code', label: 'Admit member', kind: 'check_in' }],
    });
    await stage(templateId, 'v1', 'v2', (manifest) => {
      manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager' };
    });
    const pass = await kit.scanPass(templateId, { tier: 'vip_code' });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const projected = await card(scanner.headers, pass.id);
    expect(projected.actions).toEqual([]);
    expect(JSON.stringify(projected)).not.toContain('vip_code');
  });

  it('does not expose reward labels copied from a role-restricted source', async () => {
    const templateId = await kit.scanTemplate('Private action reward', {
      actions: [
        { id: 'enter', label: 'Admit member', kind: 'check_in' },
        {
          id: 'redeem',
          label: 'Redeem',
          kind: 'take',
          input: 'balance',
          amount: 1,
          rewardLabel: 'vip_code',
        },
      ],
    });
    await stage(templateId, 'v1', 'v2', (manifest) => {
      manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager' };
    });
    const pass = await kit.scanPass(templateId, { tier: 'vip_code', balance: 5 });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const projected = await card(scanner.headers, pass.id);
    expect(projected.actions.some((action) => action.id === 'enter')).toBe(true);
    expect(projected.actions.some((action) => action.id === 'redeem')).toBe(false);
    expect(JSON.stringify(projected)).not.toContain('vip_code');
  });

  it('redacts a manager-only historical action after the same staff member is downgraded', async () => {
    const templateId = await kit.scanTemplate('Manager action', {
      actions: [{ id: 'enter', label: 'Manager entry', kind: 'check_in', minRole: 'manager' }],
    });
    const pass = await kit.scanPass(templateId);
    const { scanner, staff } = await manager(templateId);
    const scanId = await act(scanner.headers, pass.id);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Manager entry');
    await run(kit.env.DB, "UPDATE scan_staff SET role='door', updated_at=updated_at+1 WHERE id=?", [
      staff.id,
    ]);
    const downgraded = await card(scanner.headers, pass.id);
    expect(downgraded.lastScans.find((row) => row.scanId === scanId)).toBeUndefined();
    expect(downgraded.actions.find((item) => item.id === 'enter')).toMatchObject({
      lock: 'approval',
    });
  });

  it('keeps a proven public scan while omitting a newer role-restricted scan', async () => {
    const templateId = await kit.scanTemplate('Mixed card history', {
      actions: [
        { id: 'enter', label: 'Public entry', kind: 'check_in', repeat: 'always' },
        {
          id: 'private_entry',
          label: 'Manager entry',
          kind: 'check_in',
          repeat: 'always',
          minRole: 'manager',
        },
      ],
    });
    const pass = await kit.scanPass(templateId);
    const door = await kit.scanner({ templateIds: [templateId] });
    const high = await manager(templateId);
    const publicId = await act(door.headers, pass.id);
    kit.clock.advance(1);
    const response = await kit.post(high.scanner.headers, '/actions', {
      ...body(pass.id),
      actionId: 'private_entry',
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome.kind).toBe('ok');
    if (!outcome.scanId) throw new Error('Expected a manager scan');
    const rows = (await card(door.headers, pass.id)).lastScans;
    expect(rows.map((row) => row.scanId)).toEqual([publicId]);
    expect(JSON.stringify(rows)).not.toContain('Manager entry');
    expect(last(await card(high.scanner.headers, pass.id), outcome.scanId).actionLabel).toBe(
      'Manager entry',
    );
  });
});
