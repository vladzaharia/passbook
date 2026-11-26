import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from './api.ts';
import { resetModeForTests, setMode } from './mode.ts';
import {
  type ToolApi,
  ToolScopeProvider,
  useToolApi,
  useToolMode,
  useToolScope,
} from './tool-api.tsx';

const token = { get: async () => ({}) } as unknown as ToolApi;

afterEach(() => resetModeForTests());

describe('tool scope', () => {
  it('is admin by default: the session client and the mode switch', () => {
    setMode('live');
    const { result } = renderHook(() => ({
      api: useToolApi(),
      mode: useToolMode(),
      scope: useToolScope(),
    }));
    expect(result.current.api).toBe(api);
    expect(result.current.mode).toBe('live');
    expect(result.current.scope).toBeNull();
  });

  it('pins a host client, mode and org whatever the switch says', () => {
    setMode('live');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ToolScopeProvider api={token} mode="test" orgId="org-wb">
        {children}
      </ToolScopeProvider>
    );
    const { result } = renderHook(
      () => ({ api: useToolApi(), mode: useToolMode(), scope: useToolScope() }),
      { wrapper },
    );
    expect(result.current.api).toBe(token);
    expect(result.current.mode).toBe('test');
    expect(result.current.scope?.orgId).toBe('org-wb');
  });
});
