import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { states } from './fixtures.test-support.ts';
import { fakeDeps } from './store.test-support.ts';
import { createScanStore } from './store.ts';
import { ScanStoreContext, useScanMachine } from './use-scan-machine.ts';

describe('useScanMachine', () => {
  it('reads the store in context and re-renders on dispatch', () => {
    const store = createScanStore(fakeDeps().deps, states.ready());
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ScanStoreContext.Provider value={store}>{children}</ScanStoreContext.Provider>
    );
    const { result } = renderHook(() => useScanMachine(), { wrapper });
    expect(result.current.state.prefs.sound).toBe(true);
    act(() => result.current.dispatch({ type: 'prefs', prefs: { sound: false } }));
    expect(result.current.state.prefs.sound).toBe(false);
    expect(result.current.view.tint).toBe('none');
  });

  it('throws outside a provider', () => {
    expect(() => renderHook(() => useScanMachine())).toThrow(/ScanStoreContext/);
  });
});
