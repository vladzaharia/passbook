import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { API_VERSIONS, atLeast, pinnedVersion } from './api-version.ts';
import type { AppBindings } from './context.ts';
import { handleError } from './error-handler.ts';

const app = new Hono<AppBindings>();
app.onError((e, c) => handleError(e, c) as Response);
app.get('/', (c) => c.json({ pinned: pinnedVersion(c), new: atLeast(c, '2026-11-20') }));
const get = (headers: Record<string, string> = {}) => app.request('/', { headers });

describe('PassBook-Version', () => {
  it('lists the first dated version', () => {
    expect(API_VERSIONS).toContain('2026-11-20');
  });

  it('selects the dated behaviour only when pinned to it', async () => {
    expect(await (await get()).json()).toEqual({ pinned: null, new: false });
    expect(await (await get({ 'PassBook-Version': '2026-11-20' })).json()).toEqual({
      pinned: '2026-11-20',
      new: true,
    });
  });

  it('refuses a date that is not listed', async () => {
    const res = await get({ 'PassBook-Version': '2026-01-01' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('API_VERSION_UNKNOWN');
  });
});
