import { afterEach, beforeAll, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { accessTemplate, grantOf } from './access-test-fixtures.ts';
import { act, CHECK_IN, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { admitsJson } from './admits.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

/** A paired scanner in a session that admits these templates and events together. */
async function mixed(templateIds: string[], eventIds: string[]) {
  const scanner = await kit.scanner({ templateIds });
  const sessionId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
     SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at FROM scanners WHERE id=?`,
    [sessionId, admitsJson({ templateIds, eventIds }), scanner.id],
  );
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
     SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
    [sessionId, scanner.id],
  );
  return scanner.headers;
}

it('names the event only when the event admitted the pass', async () => {
  const guestTpl = await accessTemplate(undefined, 'Guest access');
  const other = await kit.scanTemplate('Ticket', { actions: [CHECK_IN] });
  const event = await kit.event({ templateIds: [other] });
  await run(kit.env.DB, 'UPDATE scan_events SET name = ? WHERE id = ?', ['Summer Gala', event.id]);
  const headers = await mixed([guestTpl, other], [event.id]);

  // The event takes the ticket: the rule is the event.
  const ticket = await out(await act(headers, codeOf(await kit.scanPass(other))));
  expect(ticket).toMatchObject({
    kind: 'ok',
    admit: { rule: { kind: 'event', name: 'Summer Gala' } },
  });

  // The event does not take the guest card: a template entry admits it, with its own rule.
  const guest = await grantOf(headers, await kit.scanPass(guestTpl, { plan: 'guest', visits: 2 }));
  expect(guest).toMatchObject({ kind: 'ok', admit: { type: 'Guest day' } });
  expect(guest.admit?.rule).toEqual({ kind: 'visit', n: 1, of: 2 });
});
