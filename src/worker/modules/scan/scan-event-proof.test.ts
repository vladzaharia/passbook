import { describe, expect, it } from 'vitest';
import type { EventRow } from '../events/repo.ts';
import { verifiedEventRoleProjection } from './history-policy.ts';
import {
  type ScanEventReference,
  sealScanEvent,
  verifyScanEventProvenance,
} from './scan-event-proof.ts';

const env = { KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(37))) };
const otherEnv = { KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(38))) };

function fixture(approved: boolean): { event: EventRow; scan: ScanEventReference } {
  const scan: ScanEventReference = {
    id: 'scan',
    orgId: 'org',
    mode: 'live',
    passId: 'pass',
    templateId: 'template',
    scannerId: 'scanner',
    eventId: null,
    actorKey: 's:scanner',
    staffId: null,
    actionId: null,
    actionKind: null,
    outcome: 'heads_up',
    reason: 'already_used',
    passVersion: 1,
    method: 'camera',
    at: 100,
    state: 'done',
    pinnedTemplateVersion: 'v1',
    walletVersion: 1,
    walletTemplateVersion: 'v1',
    direction: null,
    presenceScope: null,
  };
  const event: EventRow = {
    id: 'event',
    org_id: scan.orgId,
    pass_id: 'pass',
    mode: scan.mode,
    kind: 'scan.heads_up',
    device: null,
    actor_type: 'scanner',
    actor_id: 'scanner',
    at: 100,
    data: JSON.stringify({
      scanId: scan.id,
      actionIdRef: null,
      actionKind: null,
      outcome: scan.outcome,
      reason: scan.reason,
      version: scan.passVersion,
      eventId: null,
      scannerId: scan.scannerId,
      staffId: null,
      method: scan.method,
      approvedBy: null,
      override: false,
      authority: {
        templateId: scan.templateId,
        pinnedTemplateVersion: scan.pinnedTemplateVersion,
        pinnedReleaseId: approved ? 'pinned-release' : null,
        activeReleaseId: approved ? 'active-release' : null,
        activeReleaseGeneration: approved ? 1 : null,
        activeReleaseVersion: approved ? 'v1' : null,
        activeReleaseCandidateHash: approved ? 'candidate-hash' : null,
        activeTemplateVersion: 'v1',
        walletVersion: 1,
        walletTemplateVersion: 'v1',
        identityId: 'identity',
        identityPassTypeIdentifier: 'pass.type',
        identityTeamIdentifier: 'TEAM',
        identityRevision: 1,
        passJsonHash: 'a'.repeat(64),
        personalizationHash: null,
        evaluatedPersonalizationHash: 'b'.repeat(64),
        linkGeneration: 1,
        credentialGeneration: 1,
        lifecycleGeneration: 0,
        noPendingTransfer: true,
        orgRevision: 1,
        templateRevision: 1,
        connectionGeneration: null,
        scanAt: scan.at,
        presenceScope: null,
        nonQuarantined: true,
        effect: { gateBefore: null, gateAfter: null, presenceBefore: null, presenceAfter: null },
      },
    }),
  };
  return { event, scan };
}

const PROOF_FIELDS = [
  'eventProof',
  'credentialKeysetCommitment',
  'scannerCsrfProof',
  'sessionCsrfProof',
];

describe('recorded scan event facts', () => {
  it.each([false, true])('records the %s release snapshot as plain facts', async (approved) => {
    const { event, scan } = fixture(approved);
    const recorded = await sealScanEvent(env, event, null, scan.at, null, null);
    const authority = JSON.parse(recorded.data).authority;
    for (const field of PROOF_FIELDS) expect(authority).not.toHaveProperty(field);
    expect(authority.releaseClass).toBe(approved ? 'approved' : 'legacy');
    expect(await verifyScanEventProvenance(env, recorded, scan)).toBe(true);
    expect(await verifyScanEventProvenance(otherEnv, recorded, scan)).toBe(scan.actionId === null);
  });

  it.each([false, true])(
    'reads an old %s row that still carries proof fields',
    async (approved) => {
      const { event, scan } = fixture(approved);
      const data = JSON.parse(event.data);
      Object.assign(data.authority, {
        credentialKeysetCommitment: 'c'.repeat(64),
        scannerCsrfProof: null,
        sessionCsrfProof: 'x'.repeat(43),
        eventProof: { v: 1, releaseClass: approved ? 'approved' : 'legacy', mac: 'd'.repeat(64) },
      });
      const old = { ...event, data: JSON.stringify(data) };
      expect(await verifyScanEventProvenance(env, old, scan)).toBe(true);
    },
  );

  it('rejects a row whose facts disagree with its scan', async () => {
    const { event, scan } = fixture(false);
    const recorded = await sealScanEvent(env, event, null, scan.at, null, null);
    expect(await verifyScanEventProvenance(env, { ...recorded, actor_id: 'other' }, scan)).toBe(
      false,
    );
    expect(await verifyScanEventProvenance(env, recorded, { ...scan, orgId: 'other' })).toBe(false);
    expect(await verifyScanEventProvenance(env, recorded, { ...scan, walletVersion: 2 })).toBe(
      false,
    );
    const data = JSON.parse(recorded.data);
    data.authority.noPendingTransfer = false;
    expect(
      await verifyScanEventProvenance(env, { ...recorded, data: JSON.stringify(data) }, scan),
    ).toBe(false);
  });

  it('binds the cache to both event and scan and snapshots inputs before asynchronous verification', async () => {
    const { event, scan } = fixture(false);
    const sealed = await sealScanEvent(env, event, null, scan.at, null, null);
    const cache = new Map<string, Promise<boolean>>();
    const original = sealed.data;
    const pending = verifyScanEventProvenance(env, sealed, scan, cache);
    sealed.data = '{}';
    scan.actorKey = 's:other';
    expect(await pending).toBe(true);
    expect(await verifyScanEventProvenance(env, sealed, scan, cache)).toBe(false);
    expect(await verifyScanEventProvenance(env, { ...sealed, data: original }, scan, cache)).toBe(
      false,
    );
    expect(cache.size).toBe(3);
    for (const key of cache.keys()) expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['door', 'door'],
    ['desk', 'desk'],
    ['manager', 'manager'],
  ] as const)(
    'discloses the %s view the same for a new row and an old row',
    async (viewer, want) => {
      const { event, scan } = fixture(false);
      const data = JSON.parse(event.data);
      data.authority.role = 'manager';
      const entry = (role: string) => ({
        action: null,
        scannerNameHash: null,
        titleHash: role.padEnd(64, '0'),
      });
      data.authority.eventProjection = {
        v: 1,
        roles: { door: entry('a'), desk: entry('b'), manager: entry('c') },
      };
      const fresh = await sealScanEvent(
        env,
        { ...event, data: JSON.stringify(data) },
        null,
        scan.at,
        null,
        null,
      );
      const oldData = JSON.parse(fresh.data);
      Object.assign(oldData.authority, {
        credentialKeysetCommitment: 'c'.repeat(64),
        sessionCsrfProof: 'x'.repeat(43),
        eventProof: { v: 1, releaseClass: 'legacy', mac: 'd'.repeat(64) },
      });
      const fromNew = await verifiedEventRoleProjection(env, fresh, scan, viewer);
      const fromOld = await verifiedEventRoleProjection(
        env,
        { ...fresh, data: JSON.stringify(oldData) },
        scan,
        viewer,
      );
      expect(fromNew).toMatchObject({ role: want });
      expect(fromOld).toEqual(fromNew);
    },
  );

  it('uses only the event and scan captured before role-proof verification', async () => {
    const { event, scan } = fixture(false);
    const data = JSON.parse(event.data);
    data.authority.role = 'manager';
    data.authority.eventProjection = {
      v: 1,
      roles: { manager: { action: null, scannerNameHash: null, titleHash: null } },
    };
    const sealed = await sealScanEvent(
      env,
      { ...event, data: JSON.stringify(data) },
      null,
      scan.at,
      null,
      null,
    );
    const pending = verifiedEventRoleProjection(env, sealed, scan, 'manager');
    sealed.data = '{}';
    scan.actorKey = 's:other';
    expect(await pending).toEqual({
      role: 'manager',
      action: null,
      scannerNameHash: null,
      titleHash: null,
    });
  });

  it('refuses to seal an inconsistent transition or incomplete release tuple', async () => {
    const { event, scan } = fixture(false);
    const data = JSON.parse(event.data);
    data.authority.effect.gateAfter = { state: 'in' };
    await expect(
      sealScanEvent(env, { ...event, data: JSON.stringify(data) }, null, scan.at, null, null),
    ).rejects.toThrow();
    const broken = fixture(true);
    const release = JSON.parse(broken.event.data);
    release.authority.activeReleaseGeneration = null;
    await expect(
      sealScanEvent(
        env,
        { ...broken.event, data: JSON.stringify(release) },
        null,
        scan.at,
        null,
        null,
      ),
    ).rejects.toThrow();
    const legacy = fixture(false);
    const legacyData = JSON.parse(legacy.event.data);
    legacyData.authority.activeTemplateVersion = 'v2';
    await expect(
      sealScanEvent(
        env,
        { ...legacy.event, data: JSON.stringify(legacyData) },
        null,
        scan.at,
        null,
        null,
      ),
    ).rejects.toThrow();
    const emptyPin = fixture(true);
    const emptyPinData = JSON.parse(emptyPin.event.data);
    emptyPinData.authority.pinnedReleaseId = '';
    await expect(
      sealScanEvent(
        env,
        { ...emptyPin.event, data: JSON.stringify(emptyPinData) },
        null,
        scan.at,
        null,
        null,
      ),
    ).rejects.toThrow();
  });
});
