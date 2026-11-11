import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { captureCredentialKeyEnv, ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { livePassCommitment, livePassCommitmentValid } from './live-pass-commitment.ts';
import { livePassSnapshot, openLiveSourceProof } from './live-provenance.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import { kit, proven, row, template } from './scan-hub-test-fixtures.ts';

type TemplateVersion = { version: string; manifest: string; passJson: string; assets: string };
type TemplateDocument = {
  pinned: TemplateVersion;
  active: TemplateVersion;
  release: { candidateHash: string; contentHash: string } | null;
  issued: { candidateHash: string; contentHash: string } | null;
};

async function candidateFor(passId: string): Promise<Candidate> {
  const env = captureCredentialKeyEnv(kit.env);
  const keyset = await ensureCredentialRefKeyset(kit.env.DB, env);
  const candidate = await candidateById(kit.env.DB, kit.org.id, passId);
  if (!candidate?.templateSnapshot || candidate.credentialKeysetCommitment !== keyset)
    throw new Error('Missing original candidate template or credential snapshot.');
  return candidate;
}

function documentOf(candidate: Candidate): TemplateDocument {
  if (!candidate.templateSnapshot) throw new Error('Missing template snapshot.');
  return JSON.parse(candidate.templateSnapshot.raw) as TemplateDocument;
}

function changedTemplate(
  candidate: Candidate,
  change: (document: TemplateDocument) => void,
): Candidate {
  const document = documentOf(candidate);
  change(document);
  return { ...candidate, templateSnapshot: { raw: JSON.stringify(document) } };
}

function replaceAssetHash(version: TemplateVersion): void {
  const assets = JSON.parse(version.assets) as { sha1: string }[];
  if (!assets.length || typeof assets[0]?.sha1 !== 'string')
    throw new Error('Missing template asset.');
  assets[0].sha1 = assets[0].sha1 === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40);
  version.assets = JSON.stringify(assets);
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
}

describe('live template commitment', () => {
  it.each(['manifest', 'pass JSON', 'asset hash', 'release hash'] as const)(
    'binds the original same-version %s bytes into the keyed commitment',
    async (field) => {
      const pass = await kit.scanPass(template);
      const candidate = await candidateFor(pass.id);
      const keyEnv = captureCredentialKeyEnv(kit.env);
      const original = await livePassCommitment(keyEnv, candidate);
      expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await livePassCommitmentValid(keyEnv, candidate, original)).toBe(true);
      const changed = changedTemplate(candidate, (document) => {
        if (field === 'manifest') {
          document.pinned.manifest += ' ';
          document.active.manifest += ' ';
        } else if (field === 'pass JSON') {
          document.pinned.passJson += ' ';
          document.active.passJson += ' ';
        } else if (field === 'asset hash') {
          replaceAssetHash(document.pinned);
          replaceAssetHash(document.active);
        } else {
          if (!document.release || !document.issued) throw new Error('Missing release snapshot.');
          document.release.candidateHash = 'f'.repeat(64);
          document.issued.contentHash = 'e'.repeat(64);
        }
      });
      expect(changed.pass.templateVersion).toBe(candidate.pass.templateVersion);
      expect(changed.activeReleaseGeneration).toBe(candidate.activeReleaseGeneration);
      expect(await livePassCommitmentValid(keyEnv, changed, original)).toBe(false);
      const changedCommitment = await livePassCommitment(keyEnv, changed);
      expect(changedCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await livePassCommitmentValid(keyEnv, candidate, changedCommitment)).toBe(false);
    },
  );

  it('invalidates the earlier proof when the same version is approved at a new head generation', async () => {
    const templateId = await kit.scanTemplate('Same-version commitment policy', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const pass = await kit.scanPass(templateId);
    const keyEnv = captureCredentialKeyEnv(kit.env);
    const first = await candidateFor(pass.id);
    const commitment = await livePassCommitment(keyEnv, first);
    expect(commitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await livePassCommitmentValid(keyEnv, first, commitment)).toBe(true);
    await approveAppleRelease(kit, { templateId, version: first.pass.templateVersion });
    const current = await candidateFor(pass.id);
    expect(current.pass.templateVersion).toBe(first.pass.templateVersion);
    expect(current.activeReleaseVersion).toBe(first.activeReleaseVersion);
    expect(current.activeReleaseGeneration).toBeGreaterThan(first.activeReleaseGeneration!);
    expect(current.templateSnapshot?.raw).not.toBe(first.templateSnapshot?.raw);
    expect(await livePassCommitmentValid(keyEnv, current, commitment)).toBe(false);
  });

  it('keeps both earlier proofs stale when changed policy returns at a new release generation', async () => {
    const templateId = await kit.scanTemplate('Original commitment policy', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const pass = await kit.scanPass(templateId);
    const keyEnv = captureCredentialKeyEnv(kit.env);
    const first = await candidateFor(pass.id);
    const originalVersion = first.pass.templateVersion;
    const firstCommitment = await livePassCommitment(keyEnv, first);
    expect(firstCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await livePassCommitmentValid(keyEnv, first, firstCommitment)).toBe(true);

    const pinned = await kit.registry.resolve(templateId, originalVersion);
    const replacement = kit.registry.add({
      id: templateId,
      orgId: pinned.orgId,
      version: 'commitment-policy-v2',
      manifest: { ...pinned.manifest, name: 'Changed commitment policy' },
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, replacement, { registry: kit.registry });
    await approveAppleRelease(kit, { templateId, version: replacement.version });
    const second = await candidateFor(pass.id);
    expect(second.pass.templateVersion).toBe(originalVersion);
    expect(second.activeReleaseVersion).toBe(replacement.version);
    expect(second.activeReleaseGeneration).toBeGreaterThan(first.activeReleaseGeneration!);
    expect(second.templateSnapshot?.raw).not.toBe(first.templateSnapshot?.raw);
    expect(await livePassCommitmentValid(keyEnv, second, firstCommitment)).toBe(false);
    const secondCommitment = await livePassCommitment(keyEnv, second);
    expect(secondCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await livePassCommitmentValid(keyEnv, second, secondCommitment)).toBe(true);

    await approveAppleRelease(kit, { templateId, version: originalVersion });
    const restored = await candidateFor(pass.id);
    expect(restored.pass.templateVersion).toBe(originalVersion);
    expect(restored.activeReleaseVersion).toBe(originalVersion);
    expect(restored.activeReleaseGeneration).toBeGreaterThan(second.activeReleaseGeneration!);
    expect(await livePassCommitmentValid(keyEnv, restored, firstCommitment)).toBe(false);
    expect(await livePassCommitmentValid(keyEnv, restored, secondCommitment)).toBe(false);
  });

  it('rejects changed R2 asset bytes even when the committed snapshot metadata is unchanged', async () => {
    const templateId = await kit.scanTemplate('Private commitment asset', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const pass = await kit.scanPass(templateId);
    const candidate = await candidateFor(pass.id);
    const keyEnv = captureCredentialKeyEnv(kit.env);
    const commitment = await livePassCommitment(keyEnv, candidate);
    const resolved = await verifyLiveTemplateSnapshot(
      kit.ctx,
      candidate,
      candidate.templateSnapshot,
      'commit',
    );
    if (!resolved) throw new Error('Missing approved template snapshot.');
    const asset = resolved.pinned.assets.find((entry) => entry.source.kind === 'r2');
    if (asset?.source.kind !== 'r2') throw new Error('Missing stored template asset.');
    const object = await kit.env.BUCKET.get(asset.source.key);
    if (!object) throw new Error('Missing template asset bytes.');
    const original = new Uint8Array(await object.arrayBuffer());
    if (!original.length) throw new Error('Empty template asset bytes.');
    const changed = original.slice();
    changed[0] = original[0]! ^ 1;
    try {
      await kit.env.BUCKET.put(asset.source.key, changed);
      expect(await livePassCommitmentValid(keyEnv, candidate, commitment)).toBe(true);
      expect(
        await verifyLiveTemplateSnapshot(kit.ctx, candidate, candidate.templateSnapshot, 'commit'),
      ).toBeNull();
    } finally {
      await kit.env.BUCKET.put(asset.source.key, original);
    }
    expect(
      await verifyLiveTemplateSnapshot(kit.ctx, candidate, candidate.templateSnapshot, 'commit'),
    ).not.toBeNull();
  });

  it('captures the original template bytes before the first asynchronous boundary', async () => {
    const pass = await kit.scanPass(template);
    const candidate = await candidateFor(pass.id);
    const keyEnv = captureCredentialKeyEnv(kit.env);
    const originalRaw = candidate.templateSnapshot!.raw;
    const pending = livePassSnapshot(keyEnv, candidate);
    candidate.templateSnapshot!.raw = changedTemplate(candidate, (document) => {
      document.pinned.manifest += ' ';
    }).templateSnapshot!.raw;
    const snapshot = await pending;
    expect(snapshot.passCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await livePassCommitmentValid(keyEnv, candidate, snapshot.passCommitment)).toBe(false);
    candidate.templateSnapshot!.raw = originalRaw;
    expect(await livePassCommitmentValid(keyEnv, candidate, snapshot.passCommitment)).toBe(true);
  });

  it('binds the original pass image generation even when the pass version is unchanged', async () => {
    const pass = await kit.scanPass(template);
    const candidate = await candidateFor(pass.id);
    const keyEnv = captureCredentialKeyEnv(kit.env);
    const snapshot = await livePassSnapshot(keyEnv, candidate);
    expect(snapshot.imageGeneration).toBe(candidate.pass.imageGeneration);
    expect(snapshot.passCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const changed = {
      ...candidate,
      pass: { ...candidate.pass, imageGeneration: candidate.pass.imageGeneration + 1 },
    };
    expect(changed.pass.version).toBe(candidate.pass.version);
    expect(await livePassCommitmentValid(keyEnv, candidate, snapshot.passCommitment)).toBe(true);
    expect(await livePassCommitmentValid(keyEnv, changed, snapshot.passCommitment)).toBe(false);
  });

  it('fails closed without the original template snapshot', async () => {
    const pass = await kit.scanPass(template);
    const candidate = await candidateFor(pass.id);
    const keyEnv = captureCredentialKeyEnv(kit.env);
    const original = await livePassCommitment(keyEnv, candidate);
    expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const templateSnapshot of [null, { raw: '' }]) {
      const incomplete = { ...candidate, templateSnapshot };
      expect(await livePassCommitment(keyEnv, incomplete)).toBeNull();
      expect(await livePassCommitmentValid(keyEnv, incomplete, original)).toBe(false);
      expect((await livePassSnapshot(keyEnv, incomplete)).passCommitment).toBeNull();
    }
  });

  it('does not retain raw template data, pass tokens, scanner tokens, or CSRF in the proof', async () => {
    const pass = await kit.scanPass(
      template,
      {},
      { holderEmail: 'private-commitment@example.test' },
    );
    const candidate = await candidateFor(pass.id);
    const source = await kit.scanner({ templateIds: [template] });
    const internal = await proven(row(source.id, { passId: pass.id }));
    const proof = await openLiveSourceProof(captureCredentialKeyEnv(kit.env), internal.sourceProof);
    if (!proof?.passSnapshot?.passCommitment) throw new Error('Missing sealed pass commitment.');
    expect(
      await livePassCommitmentValid(kit.env, candidate, proof.passSnapshot.passCommitment),
    ).toBe(true);
    const document = documentOf(candidate);
    const proofStrings = stringLeaves(proof);
    const sensitive = [
      candidate.templateSnapshot!.raw,
      document.pinned.manifest,
      document.pinned.passJson,
      document.pinned.assets,
      candidate.pass.authToken,
      candidate.pass.downloadToken,
      candidate.pass.scanCode,
      candidate.pass.holderEmail,
      source.token,
      source.headers['x-csrf-token'],
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const secret of sensitive) {
      expect(proofStrings.some((value) => value.includes(secret))).toBe(false);
      expect(internal.sourceProof).not.toContain(secret);
    }
  });

  it('rejects update and replacement of a referenced template version', async () => {
    const templateId = await kit.scanTemplate('Immutable commitment version', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const pass = await kit.scanPass(templateId);
    const candidate = await candidateFor(pass.id);
    const params = [templateId, candidate.pass.templateVersion];
    await expect(
      run(
        kit.env.DB,
        `UPDATE template_versions
      SET manifest=json_set(manifest, '$.name', 'Changed') WHERE template_id=? AND version=?`,
        params,
      ),
    ).rejects.toThrow();
    await expect(
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO template_versions
      (template_id, version, manifest, pass_json, assets, report, build_key, created_by, created_at)
      SELECT template_id, version, json_set(manifest, '$.name', 'Replaced'),
        pass_json, assets, report, build_key, created_by, created_at
      FROM template_versions WHERE template_id=? AND version=?`,
        params,
      ),
    ).rejects.toThrow();
    const after = await candidateFor(pass.id);
    expect(after.templateSnapshot?.raw).toBe(candidate.templateSnapshot?.raw);
  });
});
