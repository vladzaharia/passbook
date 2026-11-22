import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { kit, setupActionFixture } from './act-test-fixtures.ts';
import { LIST, rosterOf, ticketTemplate } from './offline-test-fixtures.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const MIN = 60_000;

/** The list's signature and the device's config revision, read at the same instant. */
async function keyOf(headers: Record<string, string>) {
  const sig = (await rosterOf(headers)).sig;
  const session = (await (await kit.get(headers, '/session')).json()) as {
    counts: { configRev: number };
  };
  return { sig, rev: session.counts.configRev };
}

describe('the offline list key is the scanner config epoch', () => {
  it('a staff sign-in, sign-out and idle unbind leave it unchanged; a settings edit moves both', async () => {
    const tpl = await ticketTemplate();
    const scanner = await kit.scanner({
      templateIds: [tpl],
      settings: { ...LIST, staffSignIn: true },
    });
    const { headers } = scanner;
    const person = await kit.staff('door', 'Dana');
    const signIn = () => kit.post(headers, '/staff', { staffId: person.id, pin: person.pin });
    expect((await signIn()).status).toBe(200);
    const t = kit.clock.now();
    const first = await keyOf(headers);
    // A sign-out: unbound, and updated_at moves (there is no DELETE helper on the kit).
    await run(
      kit.env.DB,
      'UPDATE scanners SET staff_id = NULL, staff_since = NULL, updated_at = updated_at + 1 WHERE id = ?',
      [scanner.id],
    );
    expect(await signIn()).toHaveProperty('status', 200);
    expect(await keyOf(headers)).toEqual(first);
    kit.clock.advance(20 * MIN);
    // The first request after the idle-out unbinds the person (it moves updated_at, not the epoch).
    await kit.get(headers, '/session');
    expect((await signIn()).status).toBe(200);
    // The list's signature carries its download time: read it again at the first instant.
    kit.clock.set(t);
    expect(await keyOf(headers)).toEqual(first);
    await run(kit.env.DB, 'UPDATE scanners SET settings = ? WHERE id = ?', [
      JSON.stringify({ ...LIST, staffSignIn: true, whenOffline: 'decide' }),
      scanner.id,
    ]);
    const edited = await keyOf(headers);
    expect(edited.sig).not.toBe(first.sig);
    expect(edited.rev).not.toBe(first.rev);
  });
});
