import { beforeAll, describe, expect, it } from 'vitest';
import { fromBase64Url } from '../../platform/ids.ts';
import type { ScanActor } from './actor.ts';
import {
  type LiveSourceProof,
  openLiveSourceProof,
  sealLiveSourceProof,
} from './live-provenance.ts';
import { sealLiveSourceEnvelope } from './live-source-envelope.ts';
import { liveTenantFixture } from './live-tenant-test-fixtures.ts';
import {
  captureObservedScanningSession,
  restoreObservedScanningSession,
} from './scanning-workspace-observation.ts';

const fixture = liveTenantFixture();
let env: object;
let actor: ScanActor;
let proof: LiveSourceProof;
const otherEnv = { KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(18))) };

beforeAll(async () => {
  const setup = await fixture.setup();
  env = setup.kit.env;
  actor = (await fixture.managedScreen({ scoped: true })).actor;
  const keyset = setup.credentialKeysetCommitment;
  proof = {
    actor,
    eventId: 'event-random',
    credentialContext: {
      credentialKeysetCommitment: keyset,
      credentialTombstoneRefs: ['a'.repeat(64)],
      otherModeCredentialTombstoneRefs: ['b'.repeat(64)],
    },
    passId: 'pass-1',
    passSnapshot: {
      version: 3,
      revision: 4,
      orgRevision: 7,
      templateRevision: 8,
      identityRevision: 10,
      linkGeneration: 5,
      credentialGeneration: 2,
      lifecycleGeneration: 1,
      imageGeneration: 0,
      transferPending: false,
      credentialTombstoneRefs: ['a'.repeat(64)],
      otherModeCredentialTombstoneRefs: ['b'.repeat(64)],
      credentialKeysetCommitment: keyset,
      walletVersion: 3,
      walletTemplateVersion: 'pinned-template',
      connectionGeneration: 6,
      activeTemplateVersion: 'active-template',
      displayTemplateVersion: 'display-template',
      activeReleaseId: 'release-1',
      activeReleaseGeneration: 9,
      activeReleaseVersion: 'release-version',
      activeReleaseCandidateHash: 'a'.repeat(64),
      passReleaseId: 'pass-release-1',
      passCommitment: 'A'.repeat(43),
    },
    at: 100,
  };
});

async function sealEnvelope(value: unknown): Promise<string> {
  return sealLiveSourceEnvelope(env, new TextEncoder().encode(JSON.stringify(value)), {
    orgId: actor.orgId,
    mode: actor.mode,
    scannerId: actor.scanner!.id,
    eventId: proof.eventId,
  });
}

describe('live source proof', () => {
  it('seals the complete actor with randomized authenticated encryption', async () => {
    const observation = captureObservedScanningSession(actor);
    expect(observation).not.toBeNull();
    const sealed = await sealLiveSourceProof(env, proof);
    expect(await sealLiveSourceProof(env, proof)).not.toBe(sealed);
    const opened = await openLiveSourceProof(env, sealed);
    expect(opened).toEqual(proof);
    expect(captureObservedScanningSession(opened!.actor)).toEqual(observation);
    const bytes = fromBase64Url(sealed.slice('v1.'.length));
    const raw = new TextDecoder().decode(bytes);
    for (const secret of [
      actor.platformSessionId!,
      actor.scanner!.tokenHash,
      actor.scannerCsrfProof,
      actor.tenantAuthority!.sessionCsrfProof,
      proof.credentialContext.credentialKeysetCommitment,
      ...proof.passSnapshot!.credentialTombstoneRefs,
      ...proof.passSnapshot!.otherModeCredentialTombstoneRefs,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)) {
      expect(sealed).not.toContain(secret);
      expect(raw).not.toContain(secret);
    }
  });

  it('rejects unknown actor authority extensions on seal and open', async () => {
    const withExtension = { ...proof, actor: { ...actor, authorityExtension: { revision: 91 } } };
    await expect(sealLiveSourceProof(env, withExtension)).rejects.toThrow(
      'Invalid live source authority',
    );
    const ciphertext = await sealEnvelope({
      proof: withExtension,
      observation: captureObservedScanningSession(actor),
    });
    expect(await openLiveSourceProof(env, ciphertext)).toBeNull();
  });

  it('rejects missing and forged workspace observations', async () => {
    const observation = captureObservedScanningSession(actor);
    if (!observation || !actor.scanningSession)
      throw new Error('Expected authenticated workspace observation.');
    const unobserved = { ...actor, scanningSession: { ...actor.scanningSession } };
    expect(captureObservedScanningSession(unobserved)).toBeNull();
    await expect(sealLiveSourceProof(env, { ...proof, actor: unobserved })).rejects.toThrow(
      'Invalid live source authority',
    );
    const forged = {
      ...observation,
      device: { ...observation.device, session_id: 'forged-session' },
    };
    expect(restoreObservedScanningSession(unobserved, forged)).toBe(false);
    await expect(sealLiveSourceProof(env, { ...proof, actor: unobserved })).rejects.toThrow(
      'Invalid live source authority',
    );
    for (const envelope of [
      { proof },
      { proof, observation: null },
      { proof, observation: forged },
    ]) {
      expect(await openLiveSourceProof(env, await sealEnvelope(envelope))).toBeNull();
    }
  });

  it('preserves the signed-in staff revision in the original source actor', async () => {
    const staffed = {
      ...proof,
      actor: {
        ...actor,
        staff: { id: 'staff-1', name: 'Desk', role: 'desk' as const, updatedAt: 42 },
      },
    };
    expect(await openLiveSourceProof(env, await sealLiveSourceProof(env, staffed))).toEqual(
      staffed,
    );
  });

  it('rejects tampering, different keys, malformed payloads and incomplete admin lineage', async () => {
    const sealed = await sealLiveSourceProof(env, proof);
    const index = 'v1.'.length;
    const tampered =
      sealed.slice(0, index) + (sealed[index] === 'A' ? 'B' : 'A') + sealed.slice(index + 1);
    for (const invalid of [tampered, '', 'v1.A', `v2.${sealed.slice(index)}`, `${sealed}!`])
      expect(await openLiveSourceProof(env, invalid)).toBeNull();
    expect(await openLiveSourceProof(otherEnv, sealed)).toBeNull();
    expect(await openLiveSourceProof({}, sealed)).toBeNull();
    await expect(sealLiveSourceProof({}, proof)).rejects.toThrow('No KEK');
    await expect(
      sealLiveSourceProof(env, {
        ...proof,
        actor: {
          ...actor,
          scanner: { ...actor.scanner!, csrfSecret: 'source-csrf-secret-private' },
        },
      }),
    ).rejects.toThrow('Invalid live source authority');
    for (const credentialContext of [
      undefined,
      { ...proof.credentialContext, credentialTombstoneRefs: undefined },
      { ...proof.credentialContext, otherModeCredentialTombstoneRefs: ['bad'] },
      { ...proof.credentialContext, credentialKeysetCommitment: 'bad' },
    ]) {
      await expect(
        sealLiveSourceProof(env, {
          ...proof,
          credentialContext,
        } as unknown as LiveSourceProof),
      ).rejects.toThrow('Invalid live source authority');
    }
    const invalidPayloads = [
      { ...proof, actor: { ...actor, platformSessionId: undefined } },
      { ...proof, actor: { ...actor, tenantAuthority: undefined } },
      ...[
        { sessionRoles: undefined },
        { sessionRoles: [] },
        { sessionRoles: ['invalid'] },
        { amr: 'invalid' },
        { amr: undefined },
        { sessionCsrfProof: undefined },
        { sessionCsrfProof: 'bad' },
        { sessionCreatedAt: undefined },
        { sessionExpiresAt: undefined },
        { sessionExpiresAt: 1 },
      ].map((change) => ({
        ...proof,
        actor: { ...actor, tenantAuthority: { ...actor.tenantAuthority!, ...change } },
      })),
      { ...proof, actor: { ...actor, credentialKeysetCommitment: 'e'.repeat(64) } },
      { ...proof, actor: { ...actor, scanner: { ...actor.scanner!, orgId: 'other-org' } } },
      { ...proof, actor: { ...actor, scanningSession: { id: 'bad' } } },
      { ...proof, actor: { ...actor, staff: { id: 'staff-1', name: 'Desk', role: 'desk' } } },
      { ...proof, eventId: null },
      { ...proof, passSnapshot: null },
      { ...proof, passId: null },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, connectionGeneration: -1 } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, activeTemplateVersion: '' } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, activeReleaseId: '' } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, activeReleaseGeneration: -1 } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, activeReleaseVersion: '' } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, activeReleaseCandidateHash: 'bad' } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, credentialKeysetCommitment: 'bad' } },
      {
        ...proof,
        passSnapshot: { ...proof.passSnapshot!, credentialKeysetCommitment: 'e'.repeat(64) },
      },
      {
        ...proof,
        passSnapshot: {
          ...proof.passSnapshot!,
          credentialTombstoneRefs: Array(4).fill('a'.repeat(64)),
        },
      },
      {
        ...proof,
        passSnapshot: {
          ...proof.passSnapshot!,
          otherModeCredentialTombstoneRefs: ['c'.repeat(64)],
        },
      },
      {
        ...proof,
        credentialContext: {
          ...proof.credentialContext,
          credentialTombstoneRefs: ['c'.repeat(64)],
        },
      },
      { ...proof, passSnapshot: { version: 3 } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, linkGeneration: -1 } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, imageGeneration: -1 } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, credentialTombstoneRefs: undefined } },
      { ...proof, passSnapshot: { ...proof.passSnapshot!, credentialTombstoneRefs: ['bad'] } },
      {
        ...proof,
        passSnapshot: { ...proof.passSnapshot!, otherModeCredentialTombstoneRefs: undefined },
      },
      { ...proof, at: -1 },
    ];
    for (const invalid of invalidPayloads) {
      await expect(sealLiveSourceProof(env, invalid as unknown as LiveSourceProof)).rejects.toThrow(
        'Invalid live source authority',
      );
      const ciphertext = await sealEnvelope({
        proof: invalid,
        observation: captureObservedScanningSession(actor),
      });
      expect(await openLiveSourceProof(env, ciphertext)).toBeNull();
    }
  });
});
