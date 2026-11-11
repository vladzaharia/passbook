import { expect, it, vi } from 'vitest';
import { scannerActor, withRole } from './actor.ts';
import { credentialTombstoneRefsForInput, scanCredentialKeys } from './credential-input.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { planCandidateReads } from './resolve-candidates.ts';
import { evaluate } from './resolve-evaluate.ts';
import { makeLegacyScanPass, proofedScanActor, setupScanKit } from './test-kit.ts';

it.each(['passId', 'code'] as const)(
  'uses the original %s and credential references when the input changes during CSRF work',
  async (kind) => {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Candidate input race', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const template = await kit.registry.resolve(templateId);
    const original = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const replacement = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.serial).not.toBe(original.serial);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const row = await getScanner(kit.env.DB, scanner.id);
    if (!row?.csrfSecret) throw new Error('Missing scanner authority');
    const scope = await readScannerScope(kit.env.DB, row, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, 'live', 'cookie', scope), null),
      { keysetPolicy: 'defer' },
    );
    const input =
      kind === 'passId'
        ? { passId: original.id, method: 'manual' as const }
        : { code: original.serial, method: 'manual' as const };
    const refs = await credentialTombstoneRefsForInput(
      kit.ctx,
      actor.orgId,
      actor.mode,
      input,
      true,
      'defer',
    );
    const pending = planCandidateReads(kit.ctx, actor, input, refs);
    if ('passId' in input) input.passId = replacement.id;
    else input.code = replacement.serial;
    const plan = await pending;
    const candidates = plan.finish(await kit.env.DB.batch(plan.stmts));
    expect(candidates).toMatchObject([
      {
        pass: { id: original.id },
        credentialKeysetCommitment: refs.credentialKeysetCommitment,
        credentialTombstoneRefs: refs.credentialTombstoneRefs,
        otherModeCredentialTombstoneRefs: refs.otherModeCredentialTombstoneRefs,
      },
    ]);
    expect(candidates).toHaveLength(1);
  },
);

it('copies supplied credential refs before asynchronous hashing', async () => {
  const kit = await setupScanKit();
  const raw = 'private-input-for-hash-race';
  const observed = {
    credentialKeysetCommitment: 'a'.repeat(64),
    credentialTombstoneRefs: ['b'.repeat(64)],
    otherModeCredentialTombstoneRefs: ['c'.repeat(64)],
  };
  const expected = structuredClone(observed);
  const pending = scanCredentialKeys(kit.env, kit.org.id, 'live', raw, true, observed);
  observed.credentialKeysetCommitment = 'd'.repeat(64);
  observed.credentialTombstoneRefs[0] = 'e'.repeat(64);
  observed.otherModeCredentialTombstoneRefs.push('f'.repeat(64));
  const keys = await pending;
  expect(keys).toMatchObject(expected);
  const refs = {
    credentialKeysetCommitment: keys.credentialKeysetCommitment,
    credentialTombstoneRefs: keys.credentialTombstoneRefs,
    otherModeCredentialTombstoneRefs: keys.otherModeCredentialTombstoneRefs,
  };
  expect(JSON.stringify(refs)).not.toContain(raw);
});

it('retains original observed refs when they change during evaluation hashing', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Evaluation input race', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row?.csrfSecret) throw new Error('Missing scanner authority');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(scannerActor(kit.ctx, row, 'live', 'cookie', scope), null),
    { keysetPolicy: 'defer' },
  );
  const input = { code: 'private-input-for-evaluation-race', method: 'manual' as const };
  const captured = await credentialTombstoneRefsForInput(
    kit.ctx,
    actor.orgId,
    actor.mode,
    input,
    true,
    'defer',
  );
  const observed = {
    credentialKeysetCommitment: captured.credentialKeysetCommitment,
    credentialTombstoneRefs: [...captured.credentialTombstoneRefs],
    otherModeCredentialTombstoneRefs: [...captured.otherModeCredentialTombstoneRefs],
  };
  const expected = structuredClone(observed);
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  let mutated = false;
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    const result = await nativeDigest(algorithm, data);
    if (!mutated && new TextDecoder().decode(data) === input.code) {
      mutated = true;
      observed.credentialKeysetCommitment = 'a'.repeat(64);
      observed.credentialTombstoneRefs[0] = 'b'.repeat(64);
      observed.otherModeCredentialTombstoneRefs.push('c'.repeat(64));
    }
    return result;
  });
  try {
    const result = await evaluate(kit.ctx, actor, input, {}, observed);
    expect(mutated).toBe(true);
    expect(result).toMatchObject({ stop: true, reason: 'not_found', ...expected });
    expect(JSON.stringify(result)).not.toContain(input.code);
  } finally {
    digest.mockRestore();
  }
});

it('keeps original actor authority, scope and key environment across asynchronous work', async () => {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Candidate actor race', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const template = await kit.registry.resolve(templateId);
  const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row?.csrfSecret) throw new Error('Missing scanner authority');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(scannerActor(kit.ctx, row, 'live', 'cookie', scope), null),
    { keysetPolicy: 'defer' },
  );
  const input = { code: pass.serial, method: 'manual' as const };
  const refs = await credentialTombstoneRefsForInput(
    kit.ctx,
    actor.orgId,
    actor.mode,
    input,
    true,
    'defer',
  );
  const originalKey = kit.env.KEK_V1;
  const alternateKey = btoa('z'.repeat(32));
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  let mutated = false;
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    const result = await nativeDigest(algorithm, data);
    if (!mutated && new TextDecoder().decode(data) === input.code) {
      mutated = true;
      actor.orgId = 'different-org';
      actor.role = null;
      actor.templateIds.splice(0, actor.templateIds.length, 'different-template');
      if (actor.scanner) actor.scanner.id = 'different-scanner';
    }
    return result;
  });
  try {
    const pending = planCandidateReads(kit.ctx, actor, input, refs);
    kit.env.KEK_V1 = originalKey === alternateKey ? btoa('y'.repeat(32)) : alternateKey;
    const plan = await pending;
    expect(mutated).toBe(true);
    expect(plan.finish(await kit.env.DB.batch(plan.stmts))).toMatchObject([
      {
        pass: { id: pass.id, orgId: kit.org.id },
        ...refs,
      },
    ]);
  } finally {
    kit.env.KEK_V1 = originalKey;
    digest.mockRestore();
  }
});
