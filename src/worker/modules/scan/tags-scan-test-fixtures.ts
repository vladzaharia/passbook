import { makeUser, type ScannerFixture } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { workspace } from './repo-session-activity-authority-test-fixtures.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
type Over = NonNullable<Parameters<ScanKit['scanner']>[0]>;

/** A scan kit with tags on for its org, a template with a pass window, and scanners at each role. */
export async function tagScanFixture(options: { enabled?: boolean } = {}) {
  const kit = await setupScanKit();
  const tpl = await kit.scanTemplate('Gym card', {
    actions: [CHECK_IN],
    window: { from: 'startsAt', until: 'endsAt' },
  });
  const otherTpl = await kit.scanTemplate('Pool card', { actions: [CHECK_IN] });
  const db = kit.env.DB;
  if (options.enabled !== false)
    await run(
      db,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'nfc.tags', '{\"enabled\":true}', 1)",
      [`org:${kit.org.id}`],
    );
  let counter = 0;
  const uid = () => `04${(++counter).toString(16).padStart(12, '0')}`;
  const read = (u: string = uid()) => ({ uid: u, tech: 'a' as const, source: 'native' as const });

  const desk = (over: Over & { tags?: object } = {}): Promise<ScannerFixture> => {
    const { tags, settings, ...rest } = over;
    return kit.scanner({
      templateIds: [tpl],
      ...rest,
      settings: { roleWithoutSignIn: 'desk', ...(tags ? { tags } : {}), ...settings },
    });
  };
  const door = (over: Over = {}) =>
    kit.scanner({ templateIds: [tpl], ...over, settings: { roleWithoutSignIn: 'door' } });
  /** A scanner with a signed-in Manager. */
  async function manager(over: Over & { tags?: object } = {}) {
    const staff = await kit.staff('manager');
    const { tags, settings, ...rest } = over;
    const scanner = await kit.scanner({
      templateIds: [tpl],
      staffId: staff.id,
      ...rest,
      settings: { staffSignIn: true, ...(tags ? { tags } : {}), ...settings },
    });
    return { scanner, staff };
  }

  const userById = async (id: string) => {
    const row = await first<{ primary_email: string }>(
      db,
      'SELECT primary_email FROM users WHERE id = ?',
      [id],
    );
    return { id, primaryEmail: row?.primary_email ?? '' };
  };

  async function pass(
    options: {
      owner?: boolean;
      /** An existing owner, so one person can hold passes on several templates. */
      ownerId?: string;
      template?: string;
      input?: Record<string, unknown>;
    } = {},
  ) {
    const user = options.ownerId
      ? await userById(options.ownerId)
      : options.owner
        ? await makeUser(kit.fx)
        : null;
    const p = await kit.scanPass(
      options.template ?? tpl,
      options.input ?? {},
      user ? { holderEmail: user.primaryEmail } : {},
    );
    if (user) {
      await run(db, 'UPDATE users SET name = ? WHERE id = ?', ['Jane Owner', user.id]);
      await run(db, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [user.id, p.id]);
    }
    return {
      pass: p,
      ownerId: user?.id ?? null,
      card: { code: p.scanCode ?? '', method: 'camera' as const },
    };
  }

  const bind = (s: ScannerFixture, body: Record<string, unknown>) =>
    kit.post(s.headers, '/tags/bind', { idempotencyKey: key(), tag: read(), ...body });
  const inspect = (s: ScannerFixture, tag: unknown) =>
    kit.post(s.headers, '/tags/inspect', { tag });
  const undo = (s: ScannerFixture, bindingId: string) =>
    kit.post(s.headers, `/tags/bindings/${bindingId}/undo`, {});

  const active = () =>
    all<{
      id: string;
      scope: string;
      pass_id: string;
      user_id: string | null;
      scanner_id: string | null;
      bound_by_type: string;
    }>(
      db,
      'SELECT id, scope, pass_id, user_id, scanner_id, bound_by_type FROM tag_bindings WHERE ended_at IS NULL ORDER BY rowid',
    );
  const count = async (sql: string, params: (string | number)[] = []) =>
    (await first<{ n: number }>(db, sql, params))?.n ?? 0;

  return {
    kit,
    tpl,
    otherTpl,
    uid,
    read,
    desk,
    door,
    manager,
    pass,
    bind,
    inspect,
    undo,
    active,
    count,
    workspace,
  };
}

export type TagScanFixture = Awaited<ReturnType<typeof tagScanFixture>>;
