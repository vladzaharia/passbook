import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, approve, card, last, manager, simple, stage } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('checks the original approved head even if the current head later relaxes the action role', async () => {
    const { templateId, pass } = await simple('Policy entry');
    await stage(templateId, 'v1', 'v2', (manifest) => {
      manifest.scan!.actions[0]!.minRole = 'manager';
    });
    const high = await manager(templateId);
    const scanId = await act(high.scanner.headers, pass.id);
    await approve(templateId, 'v1');
    const door = await kit.scanner({ templateIds: [templateId] });
    expect(
      (await card(door.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toBeUndefined();
    expect(last(await card(high.scanner.headers, pass.id), scanId).actionLabel).toBe(
      'Policy entry',
    );
  });

  it('also respects a newly tightened current head while retaining proven public history after rollback', async () => {
    const { templateId, pass, scanner } = await simple('Public entry');
    const scanId = await act(scanner.headers, pass.id);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Public entry');
    await stage(templateId, 'v1', 'v2', (manifest) => {
      manifest.scan!.actions[0]!.minRole = 'manager';
    });
    expect(
      (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toBeUndefined();
    await approve(templateId, 'v1');
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Public entry');
  });

  it('does not substitute a later label for the signed event-time label', async () => {
    const { templateId, pass, scanner } = await simple('Original entry');
    const scanId = await act(scanner.headers, pass.id);
    await stage(templateId, 'v1', 'v2', (manifest) => {
      // "Renamed" contains the Wallet field key `name`, which the event projection withholds.
      manifest.scan!.actions[0]!.label = 'Other entry';
    });
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Original entry');
    const release = await approveAppleRelease(kit, { templateId, version: 'v2', mode: 'live' });
    await run(kit.env.DB, "UPDATE passes SET template_version='v2', release_id=? WHERE id=?", [
      release.id,
      pass.id,
    ]);
    expect(
      (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toBeUndefined();
  });

  it('accepts signed action provenance after a metadata-only pinned-template upgrade', async () => {
    const { templateId, pass, scanner } = await simple('Upgraded entry');
    await stage(templateId, 'v1', 'v2', () => {});
    const release = await approveAppleRelease(kit, { templateId, version: 'v2', mode: 'live' });
    await run(kit.env.DB, "UPDATE passes SET template_version='v2', release_id=? WHERE id=?", [
      release.id,
      pass.id,
    ]);
    const scanId = await act(scanner.headers, pass.id);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Upgraded entry');
  });

  it.each(['manager', 'hidden'] as const)(
    'intersects historical and current %s source visibility and omits hidden-source buttons',
    async (visibility) => {
      const templateId = await kit.scanTemplate('Source policy', {
        actions: [{ id: 'enter', label: 'Zone entry', kind: 'check_in' }],
      });
      await stage(templateId, 'v1', 'v2', (manifest) => {
        manifest.inputs.properties!.attendance = {
          type: 'object',
          properties: { zone: { type: 'string' } },
        };
        manifest.scan!.actions[0]!.input = 'attendance';
      });
      const pass = await kit.scanPass(templateId, { attendance: { zone: 'East' } });
      const door = await kit.scanner({ templateIds: [templateId] });
      const high = await manager(templateId);
      await stage(templateId, 'v2', 'v3', (manifest) => {
        manifest.inputs.properties!.attendance = {
          type: 'object',
          'x-scan': visibility,
          properties: { zone: { type: 'string' } },
        };
      });
      const scanId = await act(high.scanner.headers, pass.id);
      const restricted = await card(door.headers, pass.id);
      expect(restricted.lastScans.find((row) => row.scanId === scanId)).toBeUndefined();
      expect(restricted.actions.some((item) => item.id === 'enter')).toBe(false);
      await approve(templateId, 'v2');
      const relaxed = await card(door.headers, pass.id);
      expect(relaxed.actions.some((item) => item.id === 'enter')).toBe(true);
      expect(relaxed.lastScans.find((row) => row.scanId === scanId)).toBeUndefined();
      const privileged = await card(high.scanner.headers, pass.id);
      if (visibility === 'manager') expect(last(privileged, scanId).actionLabel).toBe('Zone entry');
      else expect(privileged.lastScans.find((row) => row.scanId === scanId)).toBeUndefined();
    },
  );
});
