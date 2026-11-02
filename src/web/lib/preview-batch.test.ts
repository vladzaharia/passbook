import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPreview } from './preview-batch.ts';

const preview = (id: string) => ({
  id,
  passJson: { backgroundColor: 'rgb(1,2,3)' },
  warnings: [],
  assetBaseUrl: `/api/v1/templates/${id}/versions/v1/assets`,
  assetNames: [],
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchPreview', () => {
  it('sends one request for previews asked for together and rejects a missing id', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [preview('t1'), preview('t2')] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const [a, b, c] = await Promise.allSettled([
      fetchPreview('t1'),
      fetchPreview('t2'),
      fetchPreview('t3'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls as unknown[][])[0]?.[0])).toContain('ids=t1%2Ct2%2Ct3');
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    expect(c.status).toBe('rejected');
  });
});
