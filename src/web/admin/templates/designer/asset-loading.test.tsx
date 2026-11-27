import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApi } from '../../../lib/tool-api.tsx';
import { useLoadedUrls } from './assets.ts';
import { DesignerHostProvider } from './host.tsx';
import { type WorkbenchClient, workbenchDesignerHost } from './hosts.tsx';

/** A stamps template's PNGs: the card art, the base strip and the strips drawn for each count. */
const STAMP_FILES = [
  'stamps/filled.png',
  'stamps/empty.png',
  'stamps/reward.png',
  'stamps/reward-earned.png',
  'strip@2x.png',
  ...Array.from({ length: 14 }, (_, n) => `stamps/strips/${n}/strip@2x.png`),
];
const base = '/api/v1/templates/t1/versions/v1/assets';
const pathOf = (name: string) => `${base}/${encodeURIComponent(name)}?orgId=org-wb`;
const paths = (files: readonly string[]) =>
  Object.fromEntries(files.map((name) => [name, pathOf(name)]));

const client = (): WorkbenchClient => ({
  kind: 'workbench-token',
  api: {} as ToolApi,
  token: async () => 'tok',
});

let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(async () => new Response('png'));
  vi.stubGlobal('fetch', network);
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('a stamps template on the Workbench token', () => {
  it('reads each file once however often the designer asks', async () => {
    const host = workbenchDesignerHost({ orgId: 'org-wb', client: client() });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DesignerHostProvider host={host}>{children}</DesignerHostProvider>
    );
    // The card, the images list and the strip preview each list the files; every edit renews the lists.
    const { result, rerender } = renderHook(
      ({ files }: { files: readonly string[] }) => useLoadedUrls(paths(files)),
      { wrapper, initialProps: { files: STAMP_FILES.slice(0, 5) } },
    );
    for (let n = 6; n <= STAMP_FILES.length; n++) rerender({ files: STAMP_FILES.slice(0, n) });
    rerender({ files: STAMP_FILES });
    await waitFor(() =>
      expect(Object.values(result.current).filter((u) => u.startsWith('blob:'))).toHaveLength(
        STAMP_FILES.length,
      ),
    );
    // The same files again, from a second list on the page (the strip preview loads through the host).
    await Promise.all(STAMP_FILES.map((name) => host.loadAsset(pathOf(name))));
    expect(network).toHaveBeenCalledTimes(STAMP_FILES.length);
    // RL_API_TRY allows 60 a minute for everything; the files alone must stay well under it.
    expect(network.mock.calls.length).toBeLessThan(30);
  });

  it('keeps a file for the session and one request for callers that overlap', async () => {
    const host = workbenchDesignerHost({ orgId: 'org-wb', client: client() });
    const path = pathOf('stamps/filled.png');
    const first = new AbortController();
    const [a, b] = [host.loadAsset(path, first.signal), host.loadAsset(path)];
    first.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await expect(b).resolves.toBeInstanceOf(Blob);
    await host.loadAsset(path);
    expect(network).toHaveBeenCalledTimes(1);
    // The token's other client has its own session, so its own reads.
    await workbenchDesignerHost({ orgId: 'org-wb', client: client() }).loadAsset(path);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('retries a file that failed, and does not keep org branding', async () => {
    const host = workbenchDesignerHost({ orgId: 'org-wb', client: client() });
    const path = pathOf('stamps/empty.png');
    network.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(host.loadAsset(path)).rejects.toMatchObject({ status: 429 });
    await expect(host.loadAsset(path)).resolves.toBeInstanceOf(Blob);
    const logo = '/api/v1/orgs/org-wb/brand/logo';
    await host.loadAsset(logo);
    await host.loadAsset(logo);
    expect(network).toHaveBeenCalledTimes(4);
  });
});
