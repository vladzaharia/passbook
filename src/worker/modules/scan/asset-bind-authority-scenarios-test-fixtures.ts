import { expect } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { captureScanTenantAuthority, type ScanActor, tenantScanRole } from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import type { AssetGrantSource, PreparedAssetGrant } from './asset-types.ts';
import { preparePhotoGrant } from './assets.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { livePassSnapshot, openLiveSourceProof, sealLiveSourceProof } from './live-provenance.ts';
import {
  seedAssetScanningWorkspace,
  seedScannerSetup,
} from './repo-asset-bind-authority-test-fixtures.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { grantScanMembership, proofedScanActor, type ScanKit } from './test-kit.ts';

export interface AuthorityGrantFixture {
  candidate: Candidate;
  admin: ScanActor;
  scanner: ScanActor;
  source: AssetGrantSource;
}

const system = { type: 'system' as const, id: null };
const png = btoa(String.fromCharCode(...makePng(270, 270)));

/** Capture real bound statements without substituting their D1 execution. */
function captureBindings(db: D1Database) {
  const values = new WeakMap<D1PreparedStatement, { sql: string; params: unknown[] }>();
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(prepared, member) {
              if (member === 'bind')
                return (...params: unknown[]) => {
                  const bound = prepared.bind(...params);
                  values.set(bound, { sql, params });
                  return bound;
                };
              const value = Reflect.get(prepared, member, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, values };
}

export async function fixture(kit: ScanKit) {
  const template = await kit.scanTemplate('Asset bind budget', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const event = await kit.event({ templateIds: [template] });
  const device = await kit.scanner({ eventId: event.id });
  const sourceDevice = await kit.scanner({ eventId: event.id });
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
  if (!auth) throw new Error('Missing real platform session');
  const tenant = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
  if (tenant.kind !== 'session') throw new Error('Missing tenant session authority');
  await seedScannerSetup(kit.env.DB, device.id, kit.org.id, user.id);
  const workspaceId = kit.fx.ids.id();
  const now = kit.clock.now();
  await seedAssetScanningWorkspace(
    kit.env.DB,
    workspaceId,
    event.id,
    now,
    device.id,
    sourceDevice.id,
    kit.org.id,
  );
  const managed = await managedAdminActor(kit.ctx, auth, 'live', kit.org.id, device.id);
  managed.platformSessionId = auth.sessionId;
  managed.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, tenant);
  managed.role = tenantScanRole(managed.tenantAuthority);
  await bindScanningSession(kit.ctx, managed);
  const admin = await proofedScanActor(kit.ctx, managed);
  const scanner = await assetActorFor(kit, device);
  const sender = await assetActorFor(kit, sourceDevice);
  const pass = await kit.scanPass(
    template,
    { memberName: 'Budget fixture' },
    { holderEmail: 'budget-holder@example.test' },
  );
  await putMemberPhoto(kit.ctx, system, pass.id, { png, includeInPass: false }, null);
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!candidate?.assetPhoto || !candidate.pass.scanCode) throw new Error('Missing pass or photo');
  const scanCode = candidate.pass.scanCode;
  const original = await scanCredentialKeys(kit.env, kit.org.id, 'live', scanCode, true);
  const additional = await scanCredentialKeys(
    kit.env,
    kit.org.id,
    'live',
    'aaaaaaaaaaaaa-aaaaaaaaaaaaa',
    false,
  );
  // No single normalized input currently yields three distinct refs; all are real keyed refs.
  const refs = [
    ...new Set([...original.credentialTombstoneRefs, ...additional.credentialTombstoneRefs]),
  ].slice(0, 3);
  expect(refs).toHaveLength(3);
  expect(candidate.credentialKeysetCommitment).toBe(original.credentialKeysetCommitment);
  expect(candidate.credentialKeysetCommitment).toMatch(/^[a-f0-9]{64}$/);
  expect(candidate.pass.imageGeneration).toBeGreaterThan(0);
  candidate.credentialTombstoneRefs = refs;
  candidate.otherModeCredentialTombstoneRefs = original.otherModeCredentialTombstoneRefs;
  const sealed = await sealLiveSourceProof(kit.env, {
    actor: sender,
    eventId: kit.fx.ids.id(),
    credentialContext: {
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
      credentialTombstoneRefs: candidate.credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs: candidate.otherModeCredentialTombstoneRefs,
    },
    passId: candidate.pass.id,
    passSnapshot: await livePassSnapshot(kit.env, candidate),
    at: now,
  });
  const proven = await openLiveSourceProof(kit.env, sealed);
  if (!proven?.actor.scanner || proven.passId !== candidate.pass.id)
    throw new Error('Invalid live source proof');
  const source = {
    sourceId: proven.actor.scanner.id,
    eventId: proven.eventId,
    actor: proven.actor,
  };
  const deviceCsrf = device.headers['x-csrf-token'];
  const sourceDeviceCsrf = sourceDevice.headers['x-csrf-token'];
  if (!deviceCsrf || !sourceDeviceCsrf) throw new Error('Missing scanner CSRF token');
  const secrets = [
    candidate.pass.authToken,
    candidate.pass.downloadToken,
    scanCode,
    session.csrf,
    auth.sessionId,
    deviceCsrf,
    sourceDeviceCsrf,
  ];
  const privateValues = [
    'Budget fixture',
    'budget-holder@example.test',
    candidate.pass.id,
    candidate.pass.serial,
    candidate.pass.objectKey,
    candidate.assetPhoto.key,
    session.cookieValue,
    device.token,
    sourceDevice.token,
  ];
  return {
    candidate,
    admin,
    scanner,
    source,
    device,
    sourceDevice,
    user,
    session,
    auth,
    secrets,
    privateValues,
  };
}

export async function planFor(
  kit: ScanKit,
  f: AuthorityGrantFixture,
  recipient: 'admin' | 'scanner',
) {
  const plan = await preparePhotoGrant(
    kit.ctx,
    f[recipient],
    f.candidate,
    f.candidate.connectionGeneration,
    f.candidate.activeTemplateVersion,
    f.source,
  );
  if (!plan) throw new Error('Expected photo grant plan');
  expect(plan).not.toHaveProperty('token');
  expect(plan.guard).not.toHaveProperty('snapshot');
  const clone = JSON.stringify(structuredClone(plan));
  expect(clone).not.toMatch(/passJsonSnapshot|passPersonalizationSnapshot|fieldSourcesSnapshot/);
  if (f.candidate.passJsonSnapshot)
    expect(clone).not.toContain(JSON.stringify(f.candidate.passJsonSnapshot).slice(1, -1));
  const scanCode = f.candidate.pass.scanCode;
  if (!scanCode) throw new Error('Missing pass scan code');
  for (const secret of [f.candidate.pass.authToken, f.candidate.pass.downloadToken, scanCode])
    expect(clone).not.toContain(secret);
  return plan;
}

export async function build(
  kit: ScanKit,
  plan: PreparedAssetGrant,
  candidate: Candidate,
  extra: OutputPredicate | readonly OutputPredicate[],
  requiredWhen?: OutputPredicate,
) {
  const captured = captureBindings(kit.env.DB);
  const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: captured.db } };
  const bind = await prepareAssetGrantInsertion(ctx, plan, undefined, candidate);
  const statements = bind(ctx.clock.now(), extra, requiredWhen);
  const bindings = statements.map((statement) => {
    const bound = captured.values.get(statement);
    if (!bound) throw new Error('Uncaptured D1 statement');
    return bound;
  });
  expect(statements.length).toBeGreaterThanOrEqual(4);
  for (const bound of bindings) expect(bound.params.length).toBeLessThan(100);
  return { statements, bindings };
}
