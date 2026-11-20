import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeScanner } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, run } from '../../platform/db.ts';
import { encoded } from '../passes/member-photo-test-fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { captureDeskPhoto } from './photo-capture.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { ORIGIN, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Desk photos', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
  });
  app = createApp({
    clock: kit.clock,
    stores: { ...denyAllStores, scanners: createScannerStore(kit.env, kit.clock) },
  });
});

const upload = (
  passId: string,
  headers: Record<string, string>,
  body: unknown = { png: encoded },
) =>
  app.request(
    `${ORIGIN}/api/v1/scan/passes/${passId}/photo`,
    {
      method: 'POST',
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
const stored = async (passId: string) =>
  (await all(kit.env.DB, 'SELECT 1 FROM member_photos WHERE pass_id = ?', [passId])).length;
const desk = () =>
  makeScanner(kit.fx, { orgId: kit.org.id, settings: { roleWithoutSignIn: 'desk' } });

describe('desk Add photo', () => {
  it('stores the photo through the member-photo path for a Desk device', async () => {
    const pass = await kit.scanPass(templateId);
    const res = await upload(pass.id, (await desk()).headers);
    expect(res.status).toBe(200);
    expect(await stored(pass.id)).toBe(1);
    const audit = await all<{ actor_type: string }>(
      kit.env.DB,
      "SELECT actor_type FROM audit_log WHERE target_id = ? AND action = 'pass.photo.put'",
      [pass.id],
    );
    expect(audit).toEqual([{ actor_type: 'scanner' }]);
  });

  it('refuses a request without the device credential', async () => {
    const pass = await kit.scanPass(templateId);
    expect((await upload(pass.id, {})).status).toBe(401);
    expect(await stored(pass.id)).toBe(0);
  });

  it('refuses a Door-role device, a terminal and a customer screen', async () => {
    const pass = await kit.scanPass(templateId);
    const door = await makeScanner(kit.fx, {
      orgId: kit.org.id,
      settings: { roleWithoutSignIn: 'door' },
    });
    expect((await upload(pass.id, door.headers)).status).toBe(403);
    const terminal = await makeScanner(kit.fx, { orgId: kit.org.id, kind: 'terminal' });
    expect((await upload(pass.id, terminal.headers)).status).toBe(403);
    const screen = await makeScanner(kit.fx, { orgId: kit.org.id, deviceRole: 'customer' });
    expect((await upload(pass.id, screen.headers)).status).toBe(403);
    expect(await stored(pass.id)).toBe(0);
  });

  it("answers another org's pass as missing and writes nothing", async () => {
    const other = await makeOrg(kit.fx);
    const foreign = await kit.pass({ orgId: other.id });
    const res = await upload(foreign.id, (await desk()).headers);
    expect(res.status).toBe(404);
    expect(await stored(foreign.id)).toBe(0);
  });

  it('refuses an oversized or malformed image', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    expect((await upload(pass.id, headers, { png: 'not base64!' })).status).toBe(422);
    expect((await upload(pass.id, headers, { png: 'A'.repeat(1_500_000) })).status).toBe(413);
    expect(await stored(pass.id)).toBe(0);
  });

  it('refuses at commit when the device is revoked or reconfigured after the guard', async () => {
    const device = await kit.scanner({
      templateIds: [templateId],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const row = await getScanner(kit.env.DB, device.id);
    if (!row?.csrfSecret) throw new Error('Missing scanner');
    const captured = async () =>
      proofedScanActor(
        kit.ctx,
        withRole(
          scannerActor(
            kit.ctx,
            row,
            'live',
            'cookie',
            await readScannerScope(kit.env.DB, row, null),
          ),
          null,
        ),
      );
    const input = { png: encoded, includeInPass: false };
    const revoked = await captured();
    // Control: the same captured authority writes while the device is intact.
    const control = await kit.scanPass(templateId);
    await expect(
      captureDeskPhoto(kit.ctx, await captured(), control.id, input),
    ).resolves.toBeDefined();
    expect(await stored(control.id)).toBe(1);
    const pass = await kit.scanPass(templateId);
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      device.id,
    ]);
    await expect(captureDeskPhoto(kit.ctx, revoked, pass.id, input)).rejects.toBeDefined();
    expect(await stored(pass.id)).toBe(0);
    await run(
      kit.env.DB,
      'UPDATE scanners SET revoked_at = NULL, config_epoch = config_epoch + 1 WHERE id = ?',
      [device.id],
    );
    await expect(captureDeskPhoto(kit.ctx, revoked, pass.id, input)).rejects.toBeDefined();
    expect(await stored(pass.id)).toBe(0);
  });
});
