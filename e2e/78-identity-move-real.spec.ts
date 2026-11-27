import { expect, test } from '@playwright/test';
import {
  type Api,
  createPass,
  freshAdminApi,
  requireActiveTemplateRelease,
  uid,
} from './helpers/api.ts';
import { runMinuteCron } from './helpers/cron.ts';
import { registerStubDevice } from './helpers/devices.ts';
import { d1, retirePlatformRoot, seedPlatformRoot } from './helpers/platform-root.ts';
import { templateFromBlueprint } from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

test.setTimeout(240_000);

const MOVES = '/api/v1/platform/apple/identity-moves';
const DAY = 86_400_000;

interface Move {
  id: string;
  oldPassId: string;
  newPassId: string;
  state: string;
  reason: string | null;
}

const movesOf = async (api: Api, orgId: string) =>
  (await api.get<{ items: Move[] }>(`${MOVES}?orgId=${orgId}&limit=100`)).items;

/** Runs the minute cron until every move row is in `state`; the rows are the failure message. */
async function sweepUntil(api: Api, orgId: string, state: string, want: number) {
  let seen: Move[] = [];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await runMinuteCron();
    seen = await movesOf(api, orgId);
    if (seen.filter((m) => m.state === state).length === want) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Expected ${want} rows ${state}: ${JSON.stringify(seen)}`);
}

test('a real move: preview, start, issue, notify, register, void', async ({ browser }) => {
  const admin = await freshAdminApi(browser);
  const root = await seedPlatformRoot();
  try {
    const slug = uid('move').toLowerCase();
    const org = await createOrgWithRoles(admin, { slug, name: `Move ${slug}` });
    const template = await templateFromBlueprint(admin, org.id, 'Move Generic', ['live', 'test']);
    const release = await requireActiveTemplateRelease(admin, org.id, template.id);
    for (let i = 0; i < 3; i++)
      await createPass(admin, org.id, {
        templateId: template.id,
        release,
        email: `${slug}-${i}@example.com`,
      });

    const preview = await admin.get<{ passes: number; holders: number; toIdentityId: string }>(
      `${MOVES}/preview?orgId=${org.id}&fromIdentityId=platform&toIdentityId=${root.id}`,
    );
    expect(preview).toMatchObject({ passes: 3, holders: 3, toIdentityId: root.id });

    const op = await admin.send<{ id: string; status: string }>(
      'POST',
      MOVES,
      { orgId: org.id, fromIdentityId: 'platform', toIdentityId: root.id },
      { 'Idempotency-Key': uid('move') },
    );
    expect(op.status).toBe('queued');

    // The job issues and tells every pass; the sweep moves nothing further until a device registers.
    await sweepUntil(admin, org.id, 'notified', 3);
    const failed = await admin.get<{ status: string; error: unknown }>(
      `/api/v1/operations/${op.id}`,
    );
    expect(failed.status).toBe('succeeded');

    // Each phone holds the old pass and adds the replacement.
    const rows = await movesOf(admin, org.id);
    for (const row of rows) {
      const device = `move-${row.id.slice(0, 8)}`;
      const oldFull = await admin.get<{ downloadUrl: string }>(`/api/v1/passes/${row.oldPassId}`);
      await registerStubDevice(admin, oldFull.downloadUrl, device);
      const newFull = await admin.get<{ downloadUrl: string }>(`/api/v1/passes/${row.newPassId}`);
      await registerStubDevice(admin, newFull.downloadUrl, device);
    }
    await sweepUntil(admin, org.id, 'registered', 3);

    // 24 hours on: the old passes are voided. The clock is real, so the registrations and timers are aged.
    const back = Date.now() - 2 * DAY;
    d1(
      `UPDATE registrations SET created_at = ${back} WHERE pass_id IN (SELECT new_pass_id FROM pass_moves WHERE org_id = '${org.id}')`,
    );
    d1(
      `UPDATE pass_moves SET registered_at = ${back}, void_at = ${back + DAY} WHERE org_id = '${org.id}'`,
    );
    await sweepUntil(admin, org.id, 'voided', 3);
    for (const row of await movesOf(admin, org.id)) {
      expect((await admin.get<{ status: string }>(`/api/v1/passes/${row.oldPassId}`)).status).toBe(
        'voided',
      );
      expect((await admin.get<{ status: string }>(`/api/v1/passes/${row.newPassId}`)).status).toBe(
        'active',
      );
    }
  } finally {
    retirePlatformRoot(root.id);
    await admin.dispose();
  }
});
