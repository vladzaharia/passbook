import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../lib/test-utils.tsx';
import { AppProviders } from '../lib/providers.tsx';
import { createQueryClient } from '../lib/query-client.ts';
import { toast } from './toaster.tsx';

describe('Toaster', () => {
  it('gives success the buddy face, decorative; errors keep their own icon', async () => {
    render(
      <AppProviders queryClient={createQueryClient()}>
        <p>Page</p>
      </AppProviders>,
    );
    act(() => {
      toast.success('Saved');
    });
    const saved = (await screen.findByText('Saved')).closest('[data-sonner-toast]');
    expect(saved?.querySelector('[data-icon] svg.wl-face')).toHaveAttribute('aria-hidden', 'true');
    act(() => {
      toast.error(new Error('Network down.'), 'Failed');
    });
    const failed = (await screen.findByText('Failed')).closest('[data-sonner-toast]');
    expect(failed?.querySelector('.wl-face')).toBeNull();
  });
});
