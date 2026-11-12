// What the new Worker does with pre-cutover data, per template shape, after migrate, bootstrap and baked sync.
import { beforeAll, describe, expect, it } from 'vitest';
import { jobCtxOf } from '../../src/worker/modules/delivery/delivery-test-fixtures.ts';
import { deliverEmail } from '../../src/worker/modules/delivery/email.ts';
import { ensureCredentialRefKeyset } from '../../src/worker/modules/passes/credential-keyset.ts';
import { overrideDeps } from '../../src/worker/modules/passes/deps.ts';
import { dailyPasses } from '../../src/worker/modules/passes/jobs.ts';
import { withKitDatabase } from '../../src/worker/modules/passes/pass-test-fixtures.ts';
import { publishPass } from '../../src/worker/modules/passes/publish.ts';
import { scannerActor, withRole } from '../../src/worker/modules/scan/actor.ts';
import { getScanner } from '../../src/worker/modules/scan/repo-device.ts';
import { readScannerScope } from '../../src/worker/modules/scan/repo-scope.ts';
import {
  key,
  proofedScanActor,
  type ScanKit,
  setupScanKit,
} from '../../src/worker/modules/scan/test-kit.ts';
import { undo } from '../../src/worker/modules/scan/undo.ts';
import { createTemplateRegistry } from '../../src/worker/modules/templates/registry.ts';
import { ManualClock } from '../../src/worker/platform/clock.ts';
import { createServiceContext } from '../../src/worker/platform/service-context.ts';
import { MOVED_AWAY_PASS, type Shape } from './legacy-seed.ts';
import { type Cutover, runCutover } from './setup.ts';

let c: Cutover;
let kit: ScanKit;
const SERVED: Shape[] = [
  'baked-unassigned',
  'baked-assigned',
  'baked-patched',
  'uploaded-active',
  'uploaded-moved',
];
const ALL: Shape[] = [...SERVED, 'uploaded-archived'];

beforeAll(async () => {
  c = await runCutover(29);
  kit = await withKitDatabase(c.legacy.db, () => setupScanKit());
  overrideDeps(kit.env, { registry: createTemplateRegistry(kit.env) });
}, 180_000);

const passOf = (shape: Shape, n: number) =>
  c.legacy.passes.find((p) => p.id === `pass-${shape}-${n}`)!;
const checkIn = (shape: Shape, barcode: string) =>
  kit.post(c.legacy.scanners[shape]!.headers, '/actions', {
    idempotencyKey: key(),
    input: { code: barcode, method: 'camera' },
    clientTs: kit.clock.now(),
    actionId: 'enter',
  });

describe.each(ALL)('cutover: %s', (shape) => {
  it('publishes a pass (refresh, re-sign) from its pre-cutover row', async () => {
    const { pass, changed } = await publishPass(jobCtxOf(kit), {
      passId: passOf(shape, 2).id,
      actor: { type: 'system', id: null },
      cause: 'admin',
      force: true,
    });
    expect(changed).toBe(true);
    expect(pass.version).toBe(2);
    // The old object key was kept as version 1 history.
    const versions = await kit.env.DB.prepare(
      'SELECT count(*) AS n FROM pass_versions WHERE pass_id = ?',
    )
      .bind(pass.id)
      .first<{ n: number }>();
    expect(versions?.n).toBe(2);
  });

  it('sends the email the old Worker queued, on the legacy intent path', async () => {
    const id = `mail-${shape}`;
    const queued = await kit.env.DB.prepare('SELECT payload FROM outbox WHERE id = ?')
      .bind(id)
      .first<{ payload: string }>();
    const intent = JSON.parse(queued?.payload ?? '{}').intent;
    expect(intent).toMatchObject({ format: 1, to: 'holder@example.com', attach: false });
    expect(intent.actor).toBeUndefined();
    const before = kit.mailer.sent.length;
    await deliverEmail(jobCtxOf(kit), id);
    const row = await kit.env.DB.prepare('SELECT state, error_code FROM outbox WHERE id = ?')
      .bind(id)
      .first();
    expect(row).toEqual({ state: 'sent', error_code: null });
    expect(kit.mailer.sent).toHaveLength(before + 1);
  });

  it('undoes the check-in the old Worker recorded', async () => {
    const scanned = passOf(shape, 3);
    const row = await getScanner(kit.env.DB, c.legacy.scanners[shape]!.id);
    const scope = await readScannerScope(kit.env.DB, row!, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row!, 'live', 'cookie', scope), null),
    );
    const { outcome } = await undo(kit.ctx, actor, scanned.scanId!, { idempotencyKey: key() });
    expect(outcome.kind).toBe('ok');
    const old = await kit.env.DB.prepare('SELECT undone_by FROM scans WHERE id = ?')
      .bind(scanned.scanId)
      .first<{ undone_by: string | null }>();
    expect(old?.undone_by).toBeTruthy();
  });
});

describe('cutover: bundle email', () => {
  it('sends the bundle email the old Worker queued', async () => {
    const queued = await kit.env.DB.prepare(
      "SELECT payload FROM outbox WHERE id = 'bmail-1'",
    ).first<{
      payload: string;
    }>();
    expect(JSON.parse(queued?.payload ?? '{}').intent).toMatchObject({
      bundleId: 'bundle-1',
      positions: [0, 1],
    });
    await deliverEmail(jobCtxOf(kit), 'bmail-1');
    const row = await kit.env.DB.prepare(
      "SELECT state, error_code FROM outbox WHERE id = 'bmail-1'",
    ).first();
    expect(row).toEqual({ state: 'sent', error_code: null });
  });
});

describe.each(SERVED)('cutover: %s scanning', (shape) => {
  it('checks in a pass by its pre-cutover barcode, before any republish', async () => {
    const res = await checkIn(shape, passOf(shape, 5).barcode);
    const o = (await res.json()) as { kind: string; reason: string | null };
    expect([res.status, o.kind, o.reason]).toEqual([200, 'ok', null]);
  });
});

describe('cutover: uploaded-archived scanning', () => {
  // An archived template has no head, but its passes still scan at their own version.
  it('checks in a pass of an archived template', async () => {
    const res = await checkIn('uploaded-archived', passOf('uploaded-archived', 5).barcode);
    const o = (await res.json()) as { kind: string; reason: string | null };
    expect([res.status, o.kind, o.reason]).toEqual([200, 'ok', null]);
  });
});

describe('cutover: uploaded-moved, the org it left', () => {
  it("purges org-b's deleted pass after the grace period, though it never had a release", async () => {
    await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const later = new ManualClock(kit.clock.now() + 8 * 86_400_000);
    await dailyPasses(createServiceContext(kit.env, { clock: later }));
    const left = await kit.env.DB.prepare('SELECT id FROM passes WHERE id = ?')
      .bind(MOVED_AWAY_PASS)
      .first();
    expect(left).toBeNull();
  });
});

describe('cutover: access', () => {
  it('gives the owner org_admin in every live org and nobody else a membership', async () => {
    const rows = await kit.env.DB.prepare(
      `SELECT m.org_id, m.user_id, m.roles, i.accepted_at FROM org_memberships m
       JOIN org_invitations i ON i.id = m.invitation_id WHERE m.revoked_at IS NULL AND m.user_id LIKE 'u-%'
       ORDER BY m.org_id`,
    ).all<{ org_id: string; user_id: string; roles: string; accepted_at: number }>();
    expect(rows.results.map((r) => [r.org_id, r.user_id, r.roles])).toEqual([
      ['org-a', 'u-owner', '["org_admin"]'],
      ['org-b', 'u-owner', '["org_admin"]'],
    ]);
    expect(rows.results.every((r) => r.accepted_at > 0)).toBe(true);
  });

  it('keeps the second platform admin on the admin role, which needs no membership', async () => {
    const u = await kit.env.DB.prepare(
      "SELECT last_roles, status FROM users WHERE id = 'u-admin2'",
    ).first();
    expect(u).toEqual({ last_roles: '["admin"]', status: 'active' });
  });
});
