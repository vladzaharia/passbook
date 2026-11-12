import { expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { CHECK_IN, kit, stageVersion } from './repo-lookup-release-test-fixtures.ts';
import { foundOf } from './resolve.ts';
import { key } from './test-kit.ts';

export function registerLookupWalletProvenanceCases() {
  it('scans with valid Wallet identity when versioned personalization cannot be reconstructed', async () => {
    const templateId = await kit.scanTemplate('Unavailable versioned source', {
      actions: [CHECK_IN],
    });
    const pass = await kit.scanPass(templateId);
    await run(kit.env.DB, "UPDATE pass_versions SET personalization='[]' WHERE pass_id=?", [
      pass.id,
    ]);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(candidate?.versionPersonalization).toBe('[]');
    expect(candidate && (await foundOf(kit.ctx, candidate))).not.toBeNull();
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ok', reason: null });
  });

  it('retains the Wallet template version across a metadata-only template change', async () => {
    const templateId = await kit.scanTemplate('Wallet template provenance', {
      actions: [CHECK_IN],
    });
    const pass = await kit.scanPass(templateId);
    await stageVersion(templateId, 'v2');
    const release = await approveAppleRelease(kit, { templateId, version: 'v2' });
    await run(
      kit.env.DB,
      'UPDATE passes SET template_version=?, release_id=?, version=2 WHERE id=?',
      ['v2', release.id, pass.id],
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(candidate).toMatchObject({
      pass: { templateVersion: 'v2', releaseId: release.id, version: 2 },
      activeReleaseId: release.id,
      walletVersion: 1,
      walletTemplateVersion: 'v1',
    });
    expect(candidate && (await foundOf(kit.ctx, candidate))).toMatchObject({
      activeVersion: 'v2',
      walletVersion: 1,
      walletTemplateVersion: 'v1',
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as {
      scanId: string | null;
      kind: string;
      reason: string | null;
    };
    expect(outcome).toMatchObject({ kind: 'ok', reason: null });
    expect(outcome.scanId).toEqual(expect.any(String));
    const recent = await kit.get(scanner.headers, '/scans');
    expect(recent.status).toBe(200);
    expect(await recent.json()).toMatchObject({
      items: [{ scanId: outcome.scanId, outcome: 'ok', actionLabel: 'Check in' }],
    });
    const summary = await kit.get(scanner.headers, '/summary');
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      total: 1,
      ok: 1,
      byAction: [{ actionId: 'check_in', label: 'Check in', count: 1 }],
    });
  });

  it('uses the latest bounded Wallet row, including a purged null instead of older JSON', async () => {
    const templateId = await kit.scanTemplate('Wallet row fence', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId, { memberName: 'Wallet Row Private Person' });
    const original = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!original?.passJsonSnapshot) throw new Error('Missing issued Wallet snapshot');
    await run(
      kit.env.DB,
      `UPDATE passes SET version=2,
      personalization=json_set(personalization, '$.memberName', ?) WHERE id=?`,
      ['Metadata Only Person', pass.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO pass_versions
      (pass_id, version, object_key, object_sha256, template_version, personalization, pass_json, cause, created_at)
      SELECT pass_id, 3, object_key, object_sha256, template_version, personalization, '{}', cause, created_at
      FROM pass_versions WHERE pass_id=? AND version=1`,
      [pass.id],
    );
    const metadataOnly = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(metadataOnly?.passJsonSnapshot).toBe(original.passJsonSnapshot);
    expect(metadataOnly?.walletVersion).toBe(original.walletVersion);
    expect(metadataOnly?.walletTemplateVersion).toBe(original.walletTemplateVersion);
    expect(metadataOnly?.versionPersonalization).toBe(original.versionPersonalization);
    expect(metadataOnly?.pass.personalization.memberName).toBe('Metadata Only Person');
    if (metadataOnly?.versionPersonalization == null)
      throw new Error('Missing Wallet row personalization');
    expect(JSON.parse(metadataOnly.versionPersonalization).memberName).toBe(
      'Wallet Row Private Person',
    );
    expect(metadataOnly && (await foundOf(kit.ctx, metadataOnly))).not.toBeNull();
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const metadataAction = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    const metadataOutcome = await metadataAction.json();
    expect(metadataOutcome).toMatchObject({ kind: 'ok', reason: null });
    expect(JSON.stringify(metadataOutcome)).not.toContain('versionPersonalization');
    expect(JSON.stringify(metadataOutcome)).not.toContain('walletVersion');
    const gates = await all(
      kit.env.DB,
      'SELECT pass_id, last_scan_id, count FROM scan_gates WHERE pass_id=?',
      [pass.id],
    );
    const events = await all(
      kit.env.DB,
      "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
      [pass.id],
    );
    expect(gates).toHaveLength(1);
    expect(events).toHaveLength(1);

    await run(
      kit.env.DB,
      `INSERT INTO pass_versions
      (pass_id, version, object_key, object_sha256, template_version, personalization, pass_json, cause, created_at, purged_at)
      SELECT pass_id, 2, NULL, NULL, template_version, personalization, NULL, cause, created_at, created_at
      FROM pass_versions WHERE pass_id=? AND version=1`,
      [pass.id],
    );
    const purged = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(purged).toMatchObject({
      passJson: null,
      passJsonSnapshot: null,
      walletVersion: 2,
      walletTemplateVersion: original.walletTemplateVersion,
      versionPersonalization: original.versionPersonalization,
    });
    expect(purged && (await foundOf(kit.ctx, purged))).toBeNull();
    for (const route of ['resolve', 'actions'] as const) {
      const response = await kit.post(scanner.headers, `/${route}`, {
        idempotencyKey: key(),
        input: { passId: pass.id, method: 'manual' },
        clientTs: kit.clock.now(),
        ...(route === 'actions' ? { actionId: 'check_in' } : {}),
      });
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ reason: 'not_found', card: null, display: null });
      expect(text).not.toContain(pass.id);
      expect(text).not.toContain('Wallet Row Private Person');
    }
    expect(
      await all(kit.env.DB, 'SELECT pass_id, last_scan_id, count FROM scan_gates WHERE pass_id=?', [
        pass.id,
      ]),
    ).toEqual(gates);
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toEqual(events);
  });
}
