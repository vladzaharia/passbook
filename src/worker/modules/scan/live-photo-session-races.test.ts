import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { tenantScanRole } from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { livePassSnapshot, sealLiveSourceProof } from './live-provenance.ts';
import { liveTenantFixture, ORIGIN } from './live-tenant-test-fixtures.ts';
import { photoAcquisition, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { joinAdminScanningSession, updateScanningDevice } from './scanning-devices.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { proofedScanActor, type ScanKit } from './test-kit.ts';

const f = liveTenantFixture();
let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
beforeAll(async () => {
  const setup = await f.setup();
  kit = setup.kit;
  app = setup.app;
});

function trackedBody(object: R2ObjectBody, onCancel: () => void): R2ObjectBody {
  const reader = object.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      async cancel(reason) {
        onCancel();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Proxy(object, {
    get(target, property) {
      if (property === 'body') return body;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Two real platform sessions on separate source and monitor devices in the same workspace. */
async function userPhoto() {
  const screen = await f.managedScreen({ scoped: true });
  if (!screen.templateId) throw new Error('Missing scoped template.');
  const sourceSession = await makeSession(kit.fx, {
    userId: screen.user.id,
    roles: ['admin', 'user'],
  });
  const sourceAuth = await createSessionStore(kit.env, kit.clock).resolve(
    sourceSession.cookieValue,
  );
  if (!sourceAuth) throw new Error('Missing source platform session.');
  const joined = await joinAdminScanningSession(
    kit.ctx,
    screen.user.id,
    'live',
    {
      sessionId: screen.workspace.id,
      deviceKey: '77777777-7777-4777-8777-777777777777',
    },
    ORIGIN,
    screen.management,
  );
  await updateScanningDevice(
    kit.ctx,
    screen.user.id,
    screen.workspace.id,
    joined.setupId,
    { surface: 'phone' },
    screen.management,
  );
  const raw = await managedAdminActor(kit.ctx, sourceAuth, 'live', kit.org.id, joined.setupId);
  raw.platformSessionId = sourceAuth.sessionId;
  raw.tenantAuthority = await f.sessionAuthority(sourceAuth);
  raw.role = tenantScanRole(raw.tenantAuthority);
  await bindScanningSession(kit.ctx, raw);
  const source = await proofedScanActor(kit.ctx, raw);
  const attachment = await f.refreshedAttachment(screen);
  const pass = await kit.scanPass(screen.templateId);
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!candidate) throw new Error('Missing pass candidate.');
  const entry = await f.provenRow(source);
  const credentialContext = {
    credentialKeysetCommitment: candidate.credentialKeysetCommitment,
    credentialTombstoneRefs: candidate.credentialTombstoneRefs,
    otherModeCredentialTombstoneRefs: candidate.otherModeCredentialTombstoneRefs,
  };
  const row = {
    ...entry,
    passId: pass.id,
    sourceProof: await sealLiveSourceProof(kit.env, {
      actor: source,
      credentialContext,
      eventId: entry.id,
      passId: pass.id,
      passSnapshot: await livePassSnapshot(kit.env, candidate),
      at: entry.at,
    }),
  };
  expect(await f.hub().publish({ orgId: kit.org.id, mode: 'live', row })).toBe(true);
  const projection = (await f.hub().snapshot(attachment)).rows.find((item) => item.id === row.id);
  if (!projection?.photoUrl) throw new Error('Missing user-backed live photo URL.');
  return {
    screen,
    sourceAuth,
    sourceSession,
    pass,
    url: new URL(projection.photoUrl, ORIGIN).toString(),
  };
}

describe('user-backed live photo stream', () => {
  it('keeps the two-session worst valid redemption within five post-guard D1 trips', async () => {
    const fixture = await userPhoto();
    const original = kit.env.DB;
    const trace = traceLiveD1(original);
    Object.assign(kit.env, { DB: trace.db });
    let response: Response;
    try {
      response = await app.request(
        fixture.url,
        { headers: fixture.screen.session.headers },
        kit.env,
      );
    } finally {
      Object.assign(kit.env, { DB: original });
    }
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const index = trace.trips.findIndex(
      (trip) => trip.kind === 'batch' && photoAcquisition(trip.statements),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(trace.trips[index]!.statements).toHaveLength(7);
    expect(trace.trips.length - index).toBeLessThanOrEqual(5);
    const final = trace.trips.slice(index + 1).flatMap((trip) => trip.statements);
    for (const label of ['csrf:source:session', 'csrf:recipient:session'])
      expect(final.some(({ sql }) => sql.includes(`scan-ephemeral-${label}`))).toBe(true);
    for (const secret of [fixture.sourceSession.csrf, fixture.screen.session.csrf]) {
      expect(final.some(({ sql }) => sql.includes(secret))).toBe(false);
      expect(final.some(({ params }) => params.includes(secret))).toBe(true);
    }
  });

  it.each([
    'source-replaced',
    'recipient-replaced',
    'source-idle',
    'recipient-idle',
    'workspace-paused',
  ] as const)('cancels an open body after %s authority changes', async (change) => {
    const fixture = await userPhoto();
    const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!stored) throw new Error('Missing photo object.');
    const valid = await app.request(
      fixture.url,
      { headers: fixture.screen.session.headers },
      kit.env,
    );
    expect(valid.status).toBe(200);
    await valid.body?.cancel();
    const originalSession = change.startsWith('source-')
      ? fixture.sourceAuth
      : fixture.screen.resolved;
    const replacement = await makeSession(kit.fx, {
      userId: fixture.screen.user.id,
      roles: ['admin', 'user'],
    });
    const newAuth = await createSessionStore(kit.env, kit.clock).resolve(replacement.cookieValue);
    if (!newAuth) throw new Error('Missing replacement session.');
    expect(newAuth.sessionId).not.toBe(originalSession.sessionId);
    await expect(
      run(kit.env.DB, 'UPDATE sessions SET csrf_secret=? WHERE id_hash=?', [
        replacement.csrf,
        originalSession.sessionId,
      ]),
    ).rejects.toThrow();
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== stored.r2_key || !object) return object;
      opened = true;
      if (change.endsWith('-replaced')) {
        await run(kit.env.DB, 'DELETE FROM sessions WHERE id_hash=?', [originalSession.sessionId]);
      } else if (change.endsWith('-idle')) {
        await run(kit.env.DB, 'UPDATE sessions SET idle_expires_at=? WHERE id_hash=?', [
          kit.clock.now(),
          originalSession.sessionId,
        ]);
      } else {
        await run(
          kit.env.DB,
          "UPDATE scanning_sessions SET status='paused',updated_at=updated_at+1 WHERE id=?",
          [fixture.screen.workspace.id],
        );
      }
      return trackedBody(object, () => {
        cancelled++;
      });
    });
    let response: Response;
    try {
      response = await app.request(
        fixture.url,
        { headers: fixture.screen.session.headers },
        kit.env,
      );
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    expect(
      await createSessionStore(kit.env, kit.clock).resolve(replacement.cookieValue),
    ).not.toBeNull();
  });
});
