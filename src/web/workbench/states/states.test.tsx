import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.ts';
import { NoAccessState } from '../../ui/no-access-state.tsx';
import { ToolHostProvider, useToolHost } from '../host/tool-host.tsx';
import { useToolApi, useToolMode, useToolScope } from '../host/tool-scope.ts';
import { failedLine, ResettingState, ToolEmpty } from './states.tsx';

afterEach(() => vi.unstubAllGlobals());

describe('shared states (design §6)', () => {
  it('says a refused place once, on the stage, with its ways on', () => {
    render(
      <NoAccessState
        heading
        title="Not available in Acme's Test mode"
        actions={<a href="/x">Go to Logs</a>}
      />,
    );
    const title = screen.getByRole('heading', {
      level: 1,
      name: "Not available in Acme's Test mode",
    });
    expect(title.closest('[data-art-host]')).toHaveClass('bg-surface-sunken');
    expect(screen.getByRole('link', { name: 'Go to Logs' })).toBeInTheDocument();
  });

  it('a tool empty state reads its line from the one copy table', () => {
    render(<ToolEmpty tool="logs" />);
    expect(screen.getByText('Waiting for your first call')).toBeInTheDocument();
    const { container } = render(<ToolEmpty tool="home" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mid-reset is a status that never takes focus', () => {
    render(<ResettingState />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Resetting');
    expect(status.querySelector('[tabindex]')).toBeNull();
  });

  it('a failure says whether it was the network, access or the server', () => {
    expect(failedLine(new ApiError({ status: 0, code: 'network' }))).toMatch(/connection/);
    expect(failedLine(new ApiError({ status: 403, code: 'forbidden' }))).toMatch(/access/);
    expect(failedLine(new ApiError({ status: 500, code: 'internal' }))).toMatch(/Try again/);
  });
});

describe('ToolHost', () => {
  it('gives a tool the token client for its context', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/workbench/token')
        ? new Response(
            JSON.stringify({
              token: 'pbtry_t',
              orgId: 'o1',
              mode: 'test',
              expiresAt: Date.now() + 9e5,
              subject: 'member',
            }),
          )
        : new Response(JSON.stringify({ ok: true })),
    );
    vi.stubGlobal('fetch', fetch);
    const context = {
      orgId: 'o1',
      name: 'O1',
      kind: 'org' as const,
      tools: ['home' as const],
      closed: false,
      timeZone: 'America/Los_Angeles',
    };
    const { result } = renderHook(
      () => ({
        api: useToolApi(),
        mode: useToolMode(),
        scope: useToolScope(),
        host: useToolHost(),
      }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <ToolHostProvider context={context}>{children}</ToolHostProvider>
          </QueryClientProvider>
        ),
      },
    );
    // The one tool scope (lib/tool-api.tsx) carries the token client, pinned to Test.
    expect(result.current.api).toBe(result.current.host.api);
    expect(result.current.mode).toBe('test');
    expect(result.current.scope?.orgId).toBe('o1');
    await expect(
      result.current.api.get('/api/v1/passes', z.object({ ok: z.boolean() })),
    ).resolves.toEqual({
      ok: true,
    });
    expect(() => renderHook(() => useToolHost())).toThrow(/outside a Workbench context/);
  });
});
