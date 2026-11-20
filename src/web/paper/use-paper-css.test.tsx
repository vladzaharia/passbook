import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaperCss } from './use-paper-css.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'adoptedStyleSheets');
});

describe('usePaperCss', () => {
  it('adopts one stylesheet while mounted, so the CSP never sees an inline style', () => {
    const replaceSync = vi.fn();
    vi.stubGlobal(
      'CSSStyleSheet',
      class {
        replaceSync = replaceSync;
      },
    );
    Object.defineProperty(document, 'adoptedStyleSheets', { value: [], writable: true });
    const { result, unmount } = renderHook(() => usePaperCss());
    expect(result.current).toBe(false);
    expect(replaceSync).toHaveBeenCalledWith(expect.stringContaining('.pp-sheet'));
    expect(document.adoptedStyleSheets).toHaveLength(1);
    unmount();
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });

  it('asks for an inline style where a browser cannot adopt one', () => {
    vi.stubGlobal('CSSStyleSheet', undefined);
    const { result } = renderHook(() => usePaperCss());
    expect(result.current).toBe(true);
  });
});
