import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_HOOKS, DAILY_CRON } from '../../jobs/cron.ts';
import { all, first, run } from '../../platform/db.ts';
import { type Harness, harness } from '../../workflows/identity-provision-test-fixtures.ts';
import { identityComponent } from '../status/checks-identity.ts';
import { runRotationAlerts } from './alerts.ts';
import { getIdentityRow } from './repo.ts';
import { planRotations } from './rotation-plan.ts';
import { startProvision } from './run-start.ts';

const DAY = 86_400_000;

afterEach(() => vi.restoreAllMocks());

async function provisioned(slug: string) {
  const h = await harness(slug);
  const { runId } = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
  await h.start(runId);
  const row = await first<{ id: string }>(
    h.env.DB,
    'SELECT id FROM signing_identities WHERE org_id = ?',
    [h.org.id],
  );
  const identity = await getIdentityRow(h.env.DB, row?.id ?? '');
  if (!identity) throw new Error('not provisioned');
  return { h, identity, notAfter: identity.not_after ?? 0 };
}

const toDaysLeft = (h: Harness, notAfter: number, days: number) =>
  h.kit.clock.set(notAfter - days * DAY);

const rotateRuns = (h: Harness, id: string) =>
  all<{ id: string; state: string }>(
    h.env.DB,
    "SELECT id, state FROM identity_runs WHERE target_id = ? AND kind = 'rotate' ORDER BY created_at, id",
    [id],
  );

describe('rotation planner', () => {
  it('runs daily with the other identity hooks', () => {
    expect(CRON_HOOKS[DAILY_CRON]?.map((hook) => hook.name)).toContain('identities.rotation_plan');
  });

  it('starts a run for a due auto identity once, and again after a failed run', async () => {
    const { h, identity, notAfter } = await provisioned('plan-due');
    expect(await planRotations(h.kit.ctx)).toBe(0);

    h.kit.clock.set(notAfter - 59 * DAY);
    expect(await planRotations(h.kit.ctx)).toBe(1);
    expect(h.workflow.created).toHaveLength(2);
    expect(await planRotations(h.kit.ctx)).toBe(0);

    const [open] = await rotateRuns(h, identity.id);
    await run(h.env.DB, "UPDATE identity_runs SET state = 'waiting' WHERE id = ?", [open?.id]);
    expect(await planRotations(h.kit.ctx)).toBe(0);

    await run(h.env.DB, "UPDATE identity_runs SET state = 'failed' WHERE id = ?", [open?.id]);
    expect(await planRotations(h.kit.ctx)).toBe(1);
    expect((await rotateRuns(h, identity.id)).map((r) => r.state).sort()).toEqual([
      'failed',
      'queued',
    ]);
  });

  it('leaves manual identities and identities not yet due alone', async () => {
    const { h, identity, notAfter } = await provisioned('plan-manual');
    await run(
      h.env.DB,
      "UPDATE signing_identities SET rotation = 'manual', next_rotation_at = 1 WHERE id = ?",
      [identity.id],
    );
    h.kit.clock.set(notAfter - 10 * DAY);
    expect(await planRotations(h.kit.ctx)).toBe(0);
    expect(await rotateRuns(h, identity.id)).toEqual([]);
  });
});

describe('failure ladder', () => {
  it('alerts at 45 days, shows amber and red, then emails daily from 7 days', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args.join(' ')));
    const { h, identity, notAfter } = await provisioned('ladder-co');
    await run(
      h.env.DB,
      `INSERT INTO users (id, name, primary_email, status, created_at, last_roles) VALUES
        ('adm-l', 'Admin', 'ladder-admin@example.test', 'active', 0, '["admin","user"]'),
        ('usr-l', 'User', 'ladder-user@example.test', 'active', 0, '["user"]'),
        ('bg-l', 'Break', 'breakglass@passbook.invalid', 'active', 0, '["admin"]')`,
    );
    // The test database is shared with other identities and admins; count this identity's mail to this admin.
    const sent = () =>
      (h.mail.mock.calls as unknown as [{ to: string; text: string; subject: string }][]).map(
        ([m]) => m,
      );
    const mails = () =>
      sent().filter(
        (m) =>
          m.to === 'ladder-admin@example.test' && m.subject.includes(identity.pass_type_identifier),
      ).length;
    const status = async () => {
      const row = await getIdentityRow(h.env.DB, identity.id);
      if (!row) throw new Error('gone');
      return identityComponent({ ...h.kit.ctx, env: h.env }, row, null).state;
    };

    toDaysLeft(h, notAfter, 46);
    await runRotationAlerts(h.kit.ctx);
    expect(mails()).toBe(0);

    toDaysLeft(h, notAfter, 45);
    await runRotationAlerts(h.kit.ctx);
    expect(mails()).toBe(1);
    expect(sent().some((m) => /ladder-user|invalid/.test(m.to))).toBe(false);
    expect(lines.some((l) => l.includes('IDENTITY_ROTATION_FAILED'))).toBe(true);
    const overdue = await all<{ action: string }>(
      h.env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action = 'identity.rotation_overdue'",
      [identity.id],
    );
    expect(overdue).toHaveLength(1);

    toDaysLeft(h, notAfter, 40);
    await runRotationAlerts(h.kit.ctx);
    expect(mails()).toBe(1);

    toDaysLeft(h, notAfter, 31);
    // Configured, not verified: no push key in the test env. Amber and red come from the expiry.
    expect(await status()).toBe('configured');
    toDaysLeft(h, notAfter, 29);
    expect(await status()).toBe('degraded');
    toDaysLeft(h, notAfter, 13);
    expect(await status()).toBe('failing');

    toDaysLeft(h, notAfter, 7);
    await runRotationAlerts(h.kit.ctx);
    await runRotationAlerts(h.kit.ctx);
    expect(mails()).toBe(2);
    h.kit.clock.advance(DAY);
    await runRotationAlerts(h.kit.ctx);
    expect(mails()).toBe(3);

    toDaysLeft(h, notAfter, -1);
    await runRotationAlerts(h.kit.ctx);
    expect(mails()).toBe(4);
    expect(sent().at(-1)?.text).toContain('expired');

    toDaysLeft(h, notAfter, -31);
    await runRotationAlerts(h.kit.ctx);
    expect(mails()).toBe(4);
    expect(
      await all(
        h.env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'identity.rotation_overdue' AND target_id = ?",
        [identity.id],
      ),
    ).toHaveLength(1);
  });
});
