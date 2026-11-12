import { beforeEach, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { versionExtrasHash } from '../templates/repo-preview-extras.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import { candidateById } from './repo-lookup.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';
import {
  approveScanReleases,
  key,
  makeLegacyScanPass,
  proofedScanActor,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

let kit: ScanKit;
beforeEach(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

async function actorFor(templateId: string) {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row) throw new Error('Missing scanner');
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(
      scannerActor(kit.ctx, row, row.mode, 'cookie', await readScannerScope(kit.env.DB, row, null)),
      null,
    ),
  );
  return { actor, scanner };
}

async function legacyBaked() {
  const template = kit.registry.add({
    id: `baked:scanner-${key()}`,
    orgId: null,
    origin: 'baked',
    manifest: kit.template.manifest,
    passJson: kit.template.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, template, { registry: kit.registry });
  await run(
    kit.env.DB,
    'INSERT INTO template_version_extra_sets (template_id, version, extras_hash) VALUES (?, ?, ?)',
    [template.id, template.version, await versionExtrasHash([])],
  );
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!candidate) throw new Error('Missing legacy candidate');
  return { template, pass, candidate };
}

describe('captured scanner template reads', () => {
  it('uses original legacy baked rows without invoking a registry or synchronous sync', async () => {
    const { template, pass, candidate } = await legacyBaked();
    const { actor } = await actorFor(template.id);
    const registry = new Proxy(kit.registry, {
      get(target, property) {
        if (property === 'resolve')
          return () => {
            throw new Error('Unexpected registry resolution');
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = { ...kit.env };
    overrideDeps(env, { ...depsOf(kit.env), registry });
    const ctx = { ...kit.ctx, env };
    const templates = resolveCandidateReadTemplates(candidate);
    expect(templates?.pinned).toMatchObject({
      id: template.id,
      version: template.version,
      origin: 'baked',
    });
    expect((await foundOf(ctx, candidate, actor))?.pass.id).toBe(pass.id);
    const resolved = await resolveOutcome(ctx, actor, {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(resolved.outcome).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
  });

  it('fences the original owner and immutable version rows in the final read', async () => {
    const { template, candidate } = await legacyBaked();
    const predicate = scanCandidateTemplateReadPredicate(candidate);
    expect(
      (await outputPredicateStmt(kit.env.DB, predicate).first<{ authorized: number }>())
        ?.authorized,
    ).toBe(1);
    await run(
      kit.env.DB,
      "UPDATE templates SET status='archived',updated_at=updated_at+1 WHERE id=?",
      [template.id],
    );
    expect(
      (await outputPredicateStmt(kit.env.DB, predicate).first<{ authorized: number }>())
        ?.authorized,
    ).toBe(0);
  });

  it('fails closed for missing, malformed, or cross-tenant original template rows', async () => {
    const { candidate } = await legacyBaked();
    if (!candidate.templateSnapshot) throw new Error('Missing template snapshot');
    const original = JSON.parse(candidate.templateSnapshot.raw) as {
      owner: { orgId: string | null };
      pinned: { manifest: string };
      active: { manifest: string };
    };
    const malformed = structuredClone(original);
    malformed.pinned.manifest = '{';
    malformed.active.manifest = '{';
    const malformedPolicy = structuredClone(original);
    const manifest = JSON.parse(malformedPolicy.pinned.manifest) as Record<string, unknown>;
    manifest.scan = { actions: [null] };
    malformedPolicy.pinned.manifest = JSON.stringify(manifest);
    malformedPolicy.active.manifest = malformedPolicy.pinned.manifest;
    const foreign = structuredClone(original);
    foreign.owner.orgId = 'foreign-org';
    for (const templateSnapshot of [
      null,
      { raw: JSON.stringify(malformed) },
      { raw: JSON.stringify(malformedPolicy) },
      { raw: JSON.stringify(foreign) },
    ]) {
      const changed = { ...candidate, templateSnapshot };
      expect(resolveCandidateReadTemplates(changed)).toBeNull();
      expect(scanCandidateTemplateReadPredicate(changed)).toEqual({ sql: '0', params: [] });
    }
  });

  it('keeps the pinned display and intersects active policy when build keys differ', async () => {
    const templateId = await kit.scanTemplate('Pinned read', {
      actions: [{ id: 'enter', label: 'Enter', kind: 'check_in', minRole: 'door' }],
    });
    const pass = await kit.scanPass(templateId);
    const pinned = await kit.registry.resolve(templateId, pass.templateVersion);
    const manifest = structuredClone(pinned.manifest);
    if (!manifest.scan) throw new Error('Missing scan manifest');
    manifest.scan.actions = [
      { id: 'enter', label: 'Enter', kind: 'check_in', minRole: 'manager' },
      { id: 'new_action', label: 'New', kind: 'check_in', minRole: 'door' },
    ];
    const active = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version: 'read-v2',
      manifest,
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, active, { registry: kit.registry, buildKey: 'different-build' });
    await approveScanReleases(kit, templateId, { version: active.version });
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Missing candidate');
    expect(candidate.displayTemplateVersion).toBeNull();
    const { actor, scanner } = await actorFor(templateId);
    const found = await foundOf(kit.ctx, candidate, actor);
    expect(found?.activePolicy.version).toBe(active.version);
    expect(found?.activeTemplate.version).toBe(pinned.version);
    expect(found?.scan.actions.map((action) => [action.id, action.minRole])).toEqual([
      ['enter', 'manager'],
    ]);
    const resolved = await resolveOutcome(kit.ctx, actor, {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(resolved.outcome).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    if (!resolved.outcome.card) throw new Error('Missing incompatible-head read card');
    const view = resolved.outcome.card.passView;
    const base = view.assetBaseUrl.replace('/api/v1/scan', '');
    expect(
      (await kit.get(scanner.headers, `${base}icon.png?g=${encodeURIComponent(view.assetGrant)}`))
        .status,
    ).toBe(200);
    expect(
      (await kit.get(scanner.headers, `${base}member.png?g=${encodeURIComponent(view.assetGrant)}`))
        .status,
    ).toBe(404);
  });
});
