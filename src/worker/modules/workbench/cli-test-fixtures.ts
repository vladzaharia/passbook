import { expect } from 'vitest';
import { run } from '../../platform/db.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

export const CLIENT = { name: 'passbook-cli', version: '0.2.0', os: 'macOS' };
const HOME = '203.0.113.7';

/** The Workbench kit plus the CLI sign-in's calls: start, lookup, approve, poll, and a person to approve. */
export async function cliKit() {
  const t = await workbenchKit();
  const db = t.kit.env.DB;
  const at = (ip: string) => ({ 'cf-connecting-ip': ip });

  const start = (ip = HOME, body: object = { client: CLIENT }) =>
    t.call('POST', '/cli/sessions', at(ip), body);
  const poll = (deviceCode: string, ip = HOME) =>
    t.call('POST', '/cli/sessions/token', at(ip), { deviceCode });
  const lookup = (browser: Record<string, string>, userCode: string, ip = HOME) =>
    t.call('POST', '/cli/sessions/lookup', { ...browser, ...at(ip) }, { userCode });
  const approve = (browser: Record<string, string>, id: string, orgId: string, ip = HOME) =>
    t.call('POST', `/cli/sessions/${id}/approve`, { ...browser, ...at(ip) }, { orgId });
  const deny = (browser: Record<string, string>, id: string, ip = HOME) =>
    t.call('POST', `/cli/sessions/${id}/deny`, { ...browser, ...at(ip) }, {});

  /** A network of its own per start: the burst guard counts 5 a minute per network. */
  let n = 0;
  const fresh = () => `203.0.${++n}.7`;

  /** A started session: the codes, and the network it started from. */
  async function started(ip = fresh(), body?: object) {
    const res = await start(ip, body);
    expect(res.status, await res.clone().text()).toBe(201);
    return {
      ip,
      ...((await res.json()) as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        expiresIn: number;
        interval: number;
      }),
    };
  }

  const roles = (userId: string, list: string[]) =>
    run(db, 'UPDATE users SET last_roles = ? WHERE id = ?', [JSON.stringify(list), userId]);

  /** A member of a regular org, signed in with Polaris ID, as the sign-in records their groups. */
  async function person(orgRoles = ['org_admin']) {
    const m = await t.member(orgRoles);
    await roles(m.user.id, ['user', 'console']);
    return m;
  }

  /** A developer with a sandbox. */
  async function sandbox() {
    const d = await t.developer();
    await roles(d.user.id, ['user', 'developer']);
    return d;
  }

  /** Start, look up, approve and poll once: the token response. */
  async function signIn(browser: Record<string, string>, orgId: string) {
    const s = await started();
    const { ip } = s;
    const found = await lookup(browser, s.userCode, ip);
    expect(found.status, await found.clone().text()).toBe(200);
    const { id } = (await found.json()) as { id: string };
    const ok = await approve(browser, id, orgId, ip);
    expect(ok.status, await ok.clone().text()).toBe(200);
    const res = await poll(s.deviceCode, ip);
    expect(res.status, await res.clone().text()).toBe(200);
    return {
      ...s,
      id,
      issued: (await res.json()) as {
        token: string;
        tokenId: string;
        orgId: string;
        expiresAt: number;
      },
    };
  }

  /** How the CLI calls: the bearer alone, no cookie, no browser signals. */
  const cli = (token: string) => ({ authorization: `Bearer ${token}`, ...at(HOME) });

  return {
    ...t,
    db,
    HOME,
    fresh,
    start,
    poll,
    lookup,
    approve,
    deny,
    started,
    person,
    sandbox,
    signIn,
    cli,
    roles,
  };
}
