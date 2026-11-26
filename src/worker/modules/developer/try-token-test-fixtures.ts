import { expect, vi } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { TryTokenSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { createAuthStores } from '../../stores.ts';
import { type BlueprintKit, blueprintKit } from '../templates/blueprint-test-fixtures.ts';
import { makeSandbox } from './sandbox-test-fixtures.ts';

export const ORIGIN = 'https://wallet.test';
/** What a browser sends with every fetch from the portal page. */
export const BROWSER = {
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
};
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
/** A try token as the portal sends it: beside the session cookie it was made for. */
export const page = (d: { session: { headers: Record<string, string> } }, token: string) => ({
  cookie: d.session.headers.cookie ?? '',
  ...bearer(token),
});
/** The token from the portal page: browser signals and the session cookie ride along. */
export const fromPage = (browser: Record<string, string>, token: string) => ({
  ...browser,
  ...bearer(token),
});

/** The production stores (try tokens included) over the blueprint kit, with Turnstile stubbed to pass. */
export async function tryKit() {
  const kit: BlueprintKit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  const app = createApp({ stores: createAuthStores(kit.env, kit.clock), clock: kit.clock });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/'))
      return Response.json({ success: true });
    // A webhook URL is checked to resolve to a public address (safe-fetch DoH).
    if (url.startsWith('https://cloudflare-dns.com/dns-query'))
      return Response.json({
        Answer: url.endsWith('type=A') ? [{ type: 1, data: '93.184.215.14' }] : [],
      });
    return realFetch(input, init);
  });
  const send = (method: string, path: string, headers: Record<string, string>) =>
    app.request(`${ORIGIN}/api/v1${path}`, { method, headers }, kit.env);

  /** A person with a sandbox and a signed-in browser session (cookie, CSRF, Origin). */
  async function developer() {
    const user = await makeUser(kit.f);
    const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
    const browser = { ...session.headers, ...BROWSER };
    const made = await makeSandbox(
      (method, path, headers, body) =>
        app.request(
          `${ORIGIN}/api/v1${path}`,
          {
            method,
            headers: { ...headers, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          kit.env,
        ),
      browser,
    );
    if (!made.key) throw new Error('A new sandbox mints its key.');
    return { user, session, browser, made, key: made.key };
  }

  async function mint(browser: Record<string, string>) {
    const res = await send('POST', '/developer/try-token', browser);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    return TryTokenSchema.parse(await res.json());
  }

  return { kit, app, send, developer, mint };
}
