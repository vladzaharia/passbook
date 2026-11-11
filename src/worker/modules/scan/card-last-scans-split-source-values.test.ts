import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, card, last, manager, simple, stage } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('uses the verified historical values when an old private value has since changed', async () => {
    const templateId = await kit.scanTemplate('Historical private value', {
      actions: [{ id: 'enter', label: 'SensitiveClass', kind: 'check_in' }],
    });
    await stage(templateId, 'v1', 'v2', (manifest) => {
      manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager' };
    });
    const pass = await kit.scanPass(templateId, { tier: 'SensitiveClass' });
    const high = await manager(templateId);
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', [
      'SensitiveClass',
      high.scanner.id,
    ]);
    const scanId = await act(high.scanner.headers, pass.id);
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization,'$.tier','Standard') WHERE id=?",
      [pass.id],
    );
    const door = await kit.scanner({ templateIds: [templateId] });
    const rows = (await card(door.headers, pass.id)).lastScans;
    expect(rows.find((row) => row.scanId === scanId)).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('SensitiveClass');
  });

  it('honors the Wallet-version source policy when historical values come from that version', async () => {
    const templateId = await kit.scanTemplate('Wallet source policy', {
      actions: [{ id: 'enter', label: 'Vault entry', kind: 'check_in' }],
    });
    await stage(templateId, 'v1', 'v2', (manifest) => {
      manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager' };
    });
    const pass = await kit.scanPass(templateId, { tier: 'Vault' });
    await stage(templateId, 'v1', 'v3', (manifest) => {
      manifest.inputs.properties!.tier = { type: 'string' };
    });
    const release = await approveAppleRelease(kit, { templateId, version: 'v3', mode: 'live' });
    await run(kit.env.DB, "UPDATE passes SET template_version='v3', release_id=? WHERE id=?", [
      release.id,
      pass.id,
    ]);
    const high = await manager(templateId);
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', [
      'Vault reader',
      high.scanner.id,
    ]);
    const scanId = await act(high.scanner.headers, pass.id);
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization,'$.tier','Other') WHERE id=?",
      [pass.id],
    );
    const door = await kit.scanner({ templateIds: [templateId] });
    const rows = (await card(door.headers, pass.id)).lastScans;
    expect(rows.find((row) => row.scanId === scanId)).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('Vault');
  });

  it('redacts an old hidden default embedded in action and scanner labels', async () => {
    const templateId = await kit.scanTemplate('Historical private default', {
      actions: [{ id: 'enter', label: 'VIP entry', kind: 'check_in' }],
    });
    const pass = await kit.scanPass(templateId);
    await stage(templateId, 'v1', 'v2', (manifest) => {
      manifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager', default: 'VIP' };
    });
    const high = await manager(templateId);
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', ['VIP desk', high.scanner.id]);
    const scanId = await act(high.scanner.headers, pass.id);
    await stage(templateId, 'v1', 'v3', (manifest) => {
      manifest.inputs.properties!.tier = { type: 'string', default: 'Bronze' };
    });
    const door = await kit.scanner({ templateIds: [templateId] });
    const rows = (await card(door.headers, pass.id)).lastScans;
    expect(rows.find((row) => row.scanId === scanId)).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('VIP');
  });

  it('does not reveal labels containing a secret from the original Wallet after it is rebuilt', async () => {
    const { pass, scanner } = await simple('WalletSensitive');
    await run(
      kit.env.DB,
      `UPDATE pass_versions
      SET pass_json=json_set(pass_json,'$.barcodes[0].altText','WalletSensitive')
      WHERE pass_id=? AND version=?`,
      [pass.id, pass.version],
    );
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', ['WalletSensitive', scanner.id]);
    const scanId = await act(scanner.headers, pass.id);
    await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'resign',
      actor: { type: 'system', id: null },
      force: true,
    });
    const rows = (await card(scanner.headers, pass.id)).lastScans;
    expect(rows.find((row) => row.scanId === scanId)).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('WalletSensitive');
  });

  it('uses the authenticated current personalization when a retained version value no longer matches', async () => {
    const { pass, scanner } = await simple('Verified entry');
    const scanId = await act(scanner.headers, pass.id);
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET personalization=json_set(personalization,'$.memberName','Changed')
      WHERE pass_id=? AND version=(SELECT json_extract(data,'$.authority.walletVersion') FROM pass_events
        WHERE pass_id=? AND json_extract(data,'$.scanId')=?)`,
      [pass.id, pass.id, scanId],
    );
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Verified entry');
  });

  it('uses a matching evaluated snapshot after a metadata-only change, and redacts once it is lost', async () => {
    const { pass, scanner } = await simple('Metadata entry');
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization,'$.memberName','New member') WHERE id=?",
      [pass.id],
    );
    const scanId = await act(scanner.headers, pass.id);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Metadata entry');
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization,'$.memberName','Different member') WHERE id=?",
      [pass.id],
    );
    expect(
      (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toBeUndefined();
  });

  it('uses verified current values without a Wallet template, but does not reconstruct from that Wallet row', async () => {
    const { pass, scanner } = await simple('Current entry');
    await run(kit.env.DB, "UPDATE pass_versions SET template_version='' WHERE pass_id=?", [
      pass.id,
    ]);
    const scanId = await act(scanner.headers, pass.id);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Current entry');
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization,'$.memberName','Changed') WHERE id=?",
      [pass.id],
    );
    expect(
      (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toBeUndefined();
  });
});
