import { render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFreshSpace } from './fresh-space.ts';
import { forgetTokens, workbenchToken } from './token.ts';

afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
});

const mint = () =>
  new Response(
    JSON.stringify({
      token: 'pbtry_1',
      orgId: 'nw',
      mode: 'test',
      expiresAt: Date.now() + 15 * 60_000,
      subject: 'member',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A tool under the layout: its first read starts a mint in its own mount effect. */
function Tool({ onRead }: { onRead: (p: Promise<string>) => void }) {
  useEffect(() => {
    onRead(workbenchToken('nw', 'csrf-1'));
  }, [onRead]);
  return null;
}

function Layout({ onRead }: { onRead: (p: Promise<string>) => void }) {
  useFreshSpace();
  return <Tool onRead={onRead} />;
}

describe('a space opening for a person (a cold Workbench load remounts the layout)', () => {
  it('forgets tokens before a tool in the same commit starts its first mint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mint()),
    );
    const reads: Promise<string>[] = [];
    render(<Layout onRead={(p) => reads.push(p)} />);
    await waitFor(() => expect(reads).toHaveLength(1));
    await expect(reads[0]).resolves.toBe('pbtry_1');
  });
});
