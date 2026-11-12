// A minted photo URL is fenced by the org's access epoch, not by its configuration: a rename moves
// only `config_revision`, a suspension moves `access_revision` (authority-epochs.md).
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { photoAssetGrantFor } from './asset-test-fixtures.ts';
import { assetGrantValid, mintAssetGrant } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import { grantScanMembership, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
const png = btoa(String.fromCharCode(...makePng(270, 270)));
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  template = await kit.scanTemplate('Org epoch photo', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function photoPass() {
  const pass = await kit.scanPass(template);
  const system = { type: 'system' as const, id: null };
  await putMemberPhoto(jobCtxOf(kit), system, pass.id, { png, includeInPass: false }, null);
  return pass;
}

const rename = () =>
  run(kit.env.DB, "UPDATE orgs SET name = name || ' (renamed)' WHERE id = ?", [kit.org.id]);

/** Suspend and reactivate: the org ends active, but its access epoch has moved twice. */
async function suspendAndRestore() {
  for (const status of ['suspended', 'active'])
    await run(kit.env.DB, 'UPDATE orgs SET status = ? WHERE id = ?', [status, kit.org.id]);
}

/** The request-time admin actor, rebuilt from the current session and org rows. */
async function adminPhotoActor(cookieValue: string) {
  const auth = await createSessionStore(kit.env, kit.clock).resolve(cookieValue);
  if (!auth) throw new Error('Session fixture missing');
  const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
  if (authority.kind !== 'session') throw new Error('Session authority fixture missing');
  const actor = adminActor(auth, 'live', {
    orgId: kit.org.id,
    event: null,
    templateIds: [],
    timeZone: 'UTC',
  });
  actor.platformSessionId = auth.sessionId;
  actor.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
  actor.role = tenantScanRole(actor.tenantAuthority);
  return actor;
}

describe('photo URLs and the org epochs', () => {
  it('keeps a device photo URL across an org rename and drops it after a suspension', async () => {
    const pass = await photoPass();
    const device = await kit.scanner({ templateIds: [template] });
    const image = (grant: string) =>
      kit.get(device.headers, `/passes/${pass.id}/assets/member.png?g=${grant}`);
    const grant = await photoAssetGrantFor(kit, device, pass.id);
    expect((await image(grant)).status).toBe(200);
    await rename();
    expect((await image(grant)).status).toBe(200);
    await suspendAndRestore();
    const revoked = await image(grant);
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    // Control: the org is active again, so a URL minted now is served.
    expect((await image(await photoAssetGrantFor(kit, device, pass.id))).status).toBe(200);
  });

  it('keeps a tenant photo grant across an org rename and drops it after a suspension', async () => {
    const pass = await photoPass();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const mint = async () => {
      const actor = await adminPhotoActor(session.cookieValue);
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate) throw new Error('Pass fixture missing');
      const generation = candidate.connectionGeneration;
      const version = candidate.activeTemplateVersion;
      return mintAssetGrant(kit.ctx, actor, candidate, generation, version, undefined, true);
    };
    const valid = async (grant: string) => {
      const actor = await adminPhotoActor(session.cookieValue);
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate) throw new Error('Pass fixture missing');
      const generation = candidate.connectionGeneration;
      return assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        generation,
        grant,
        undefined,
        'commit',
        true,
      );
    };
    const grant = await mint();
    expect(await valid(grant)).toBe(true);
    await rename();
    expect(await valid(grant)).toBe(true);
    await suspendAndRestore();
    expect(await valid(grant)).toBe(false);
    expect(await valid(await mint())).toBe(true);
  });
});
