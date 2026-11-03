import { act, render, screen } from '@testing-library/react';
import { toast as sonner } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './test-utils.tsx';
import { copyText } from './clipboard.ts';
import { AppProviders } from './providers.tsx';
import { createQueryClient } from './query-client.ts';

function stubClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  act(() => {
    sonner.dismiss();
  });
});

describe('copyText', () => {
  it('copies and confirms with a toast named after the value', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    render(<AppProviders queryClient={createQueryClient()}>{null}</AppProviders>);
    let ok = false;
    await act(async () => {
      ok = await copyText('https://x.test/p/1', 'link');
    });
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://x.test/p/1');
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });

  it('turns a refused clipboard into an error toast that says what to do', async () => {
    stubClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    render(<AppProviders queryClient={createQueryClient()}>{null}</AppProviders>);
    let ok = true;
    await act(async () => {
      ok = await copyText('wlt_abc', 'prefix');
    });
    expect(ok).toBe(false);
    const shown = (await screen.findByText('Could not copy the prefix')).closest(
      '[data-sonner-toast]',
    );
    expect(shown).toHaveTextContent('Allow clipboard access and try again.');
  });
});
