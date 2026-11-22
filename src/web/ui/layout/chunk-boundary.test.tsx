import { render, screen } from '@testing-library/react';
import { lazy } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChunkBoundary } from './chunk-boundary.tsx';

describe('ChunkBoundary', () => {
  it('shows the inline reload fallback when the lazy chunk fails to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = lazy(() =>
      Promise.reject(new Error('Failed to fetch dynamically imported module')),
    );
    render(
      <ChunkBoundary fallback={<p>Loading</p>}>
        <Broken />
      </ChunkBoundary>,
    );
    expect(screen.getByText('Loading')).toBeTruthy();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this page');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});
