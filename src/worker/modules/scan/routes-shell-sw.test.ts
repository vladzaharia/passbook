import { describe, expect, it } from 'vitest';
import { scanShellSwRoutes } from './routes-shell-sw.ts';

describe('scan shell worker route', () => {
  it('serves the worker for the build, allowed to control /scan', async () => {
    const res = await scanShellSwRoutes.request('/sw.js', {}, {
      CF_VERSION: { id: 'b9' },
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('service-worker-allowed')).toBe('/scan');
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('scan-shell:b9');
  });
});
