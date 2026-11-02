import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../test/helpers/env.ts';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { fakeRateLimiter } from '../../../test/helpers/fakes.ts';
import { createApp } from '../app.ts';
import type { AppEnv } from '../platform/env.ts';

const ORIGIN = 'https://wallet.test';
const app = createApp({ stores: fakeAuth(ORIGIN).stores });
const HTML = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };

async function call(path: string, headers: Record<string, string> = HTML, env?: AppEnv) {
  return app.request(`${ORIGIN}${path}`, { headers }, env ?? (await makeEnv()));
}

describe('browser error pages', () => {
  it('renders the hosted 404 for an unknown worker path', async () => {
    const res = await call('/auth/nothing');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("'nonce-");
    const html = await res.text();
    expect(html).toContain('<section class="card"');
    expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/);
    expect(html).toContain('href="/"');
  });

  it('keeps problem+json for the API and for clients that do not ask for HTML', async () => {
    const api = await call('/api/v1/nope');
    expect(api.headers.get('content-type')).toBe('application/problem+json');
    const json = await call('/auth/nothing', { accept: 'application/json' });
    expect(json.headers.get('content-type')).toBe('application/problem+json');
  });

  it('shows Link expired for a dead pass download link', async () => {
    const res = await call('/p/rotatedrotatedrotated0/pass.pkpass');
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/<h1[^>]*>Link expired<\/h1>/);
  });

  it('renders 429 with the wait line and keeps Retry-After', async () => {
    const env = await makeEnv({ RL_LOGIN: fakeRateLimiter({ limit: 0 }) });
    const res = await call('/auth/oidc/start', HTML, env);
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('retry-after')).toBe('60');
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>Too many requests<\/h1>/);
    expect(html).toContain('Try again in a minute.');
  });
});
