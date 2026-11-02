import { lazyRouteComponent } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError } from '../ui/error-state.tsx';
import { guardOfflineChunks, OfflineChunkError, offlineSafe } from './offline-routes.ts';

type Lazy = (() => ReactElement) & { preload?: () => Promise<void> };

const lazy = (): Lazy => {
  const C: Lazy = () => <p>Loaded</p>;
  C.preload = () => Promise.resolve();
  return C;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('offline route chunks', () => {
  it('throws a chunk-load error offline instead of letting the router reload the page', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const Safe = offlineSafe(lazy());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Safe />)).toThrow(OfflineChunkError);
    expect(isChunkLoadError(new OfflineChunkError())).toBe(true);
  });

  it('renders the route online, and once the chunk has loaded', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const C = lazy();
    const Safe = offlineSafe(C);
    render(<Safe />);
    expect(screen.getByText('Loaded')).toBeInTheDocument();
    online.mockReturnValue(false);
    C.preload = undefined;
    render(<Safe />);
    expect(screen.getAllByText('Loaded')).toHaveLength(2);
  });

  it('wraps only code-split components and forwards preload', async () => {
    const C = lazy();
    const preload = vi.spyOn(C, 'preload' as never);
    const plain = () => null;
    const route = { options: { component: C, errorComponent: plain } };
    guardOfflineChunks([route]);
    expect(route.options.component).not.toBe(C);
    expect(route.options.errorComponent).toBe(plain);
    await (route.options.component as Lazy).preload?.();
    expect(preload).toHaveBeenCalledOnce();
  });
});

describe('with the real lazyRouteComponent', () => {
  const chunk = () =>
    Promise.resolve({
      default: () => <p>Real chunk</p>,
    });

  it('throws offline before the chunk loads, and renders once it has loaded', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = lazyRouteComponent(chunk);
    const Safe = offlineSafe(real as unknown as Lazy);
    expect(() => render(<Safe />)).toThrow(OfflineChunkError);
    // Online, the router preloads the chunk; the guard then lets the route render offline too.
    online.mockReturnValue(true);
    await real.preload?.();
    online.mockReturnValue(false);
    render(<Safe />);
    await waitFor(() => expect(screen.getByText('Real chunk')).toBeInTheDocument());
  });
});
