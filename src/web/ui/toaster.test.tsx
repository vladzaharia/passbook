import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast as sonner } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';
import { ApiError } from '../lib/errors.ts';
import { AppProviders } from '../lib/providers.tsx';
import { createQueryClient } from '../lib/query-client.ts';
import { Buddy } from './art/buddy.tsx';
import { toast } from './toaster.tsx';

function renderToaster(page: React.ReactNode = <p>Page</p>) {
  return render(<AppProviders queryClient={createQueryClient()}>{page}</AppProviders>);
}

const toastOf = async (text: string) =>
  (await screen.findByText(text)).closest('[data-sonner-toast]') as HTMLElement;

afterEach(() => {
  act(() => {
    sonner.dismiss();
  });
});

describe('Toaster', () => {
  it('gives success the buddy face, decorative; errors keep their own icon', async () => {
    renderToaster();
    act(() => {
      toast.success('Saved');
    });
    const saved = await toastOf('Saved');
    expect(saved.querySelector('[data-icon] svg.wl-face')).toHaveAttribute('aria-hidden', 'true');
    act(() => {
      toast.error(new Error('Network down.'), 'Could not save');
    });
    const failed = await toastOf('Could not save');
    expect(failed.querySelector('.wl-face')).toBeNull();
  });

  it('shows a check instead of the face while a page buddy is in view', async () => {
    const { rerender } = renderToaster(<Buddy mood="sad" still />);
    act(() => {
      toast.success('Pass voided');
      toast.sent('Pass emailed');
    });
    for (const text of ['Pass voided', 'Pass emailed']) {
      const shown = await toastOf(text);
      expect(shown.querySelector('.wl-face')).toBeNull();
      expect(shown.querySelector('[data-icon] svg.lucide-circle-check')).not.toBeNull();
    }
    // The buddy leaves: the face comes back, on toasts already showing too.
    rerender(
      <AppProviders queryClient={createQueryClient()}>
        <p>Page</p>
      </AppProviders>,
    );
    await waitFor(() => expect((document.body.querySelectorAll('.wl-face') ?? []).length).toBe(2));
  });

  it('titles an error with what failed and describes it with the error, never wrapped twice', async () => {
    renderToaster();
    act(() => {
      toast.error(new ApiError({ status: 409, code: 'conflict', detail: 'Slug taken.' }), 'A');
      toast.error(new ApiError({ status: 500, code: 'boom', detail: 'stack' }), 'B');
      toast.error('Allow clipboard access and try again.', 'C');
    });
    expect(await toastOf('A')).toHaveTextContent('Slug taken.');
    expect(await toastOf('B')).toHaveTextContent('Something went wrong. Try again.');
    expect(await toastOf('C')).toHaveTextContent('Allow clipboard access and try again.');
  });

  it('gives an error a danger icon', async () => {
    renderToaster();
    act(() => {
      toast.error(new Error('x'), 'Could not save');
    });
    expect(
      (await toastOf('Could not save')).querySelector('[data-icon] svg.lucide-circle-x'),
    ).not.toBeNull();
  });

  it('sits above the fixed bottom bar and stays at the bottom with an overlay open', async () => {
    renderToaster();
    act(() => {
      toast.success('Saved');
    });
    await toastOf('Saved');
    const region = document.querySelector('[data-sonner-toaster]') as HTMLElement;
    expect(region.getAttribute('data-y-position')).toBe('bottom');
    expect(region.style.getPropertyValue('--offset-bottom')).toContain('--wl-bottom-bar');
    document.body.setAttribute('data-scroll-locked', '1');
    await new Promise((r) => setTimeout(r, 0));
    expect(region.getAttribute('data-y-position')).toBe('bottom');
    document.body.removeAttribute('data-scroll-locked');
  });

  it('puts the close button at the top right, inside the toast', async () => {
    renderToaster();
    act(() => {
      toast.success('Saved');
    });
    const close = (await toastOf('Saved')).querySelector('[data-close-button]');
    expect(close?.className).toContain('!right-2');
    expect(close?.className).toContain('!left-auto');
    expect(close?.className).toContain('!transform-none');
  });

  it('offers one follow-up with toast.action', async () => {
    const onClick = vi.fn();
    renderToaster();
    act(() => {
      toast.action('Updating 3 passes', { label: 'View run', onClick });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'View run' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('runs Undo, and turns a failed undo into an error toast', async () => {
    const onUndo = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 409, code: 'x', detail: 'Too late.' }));
    renderToaster();
    act(() => {
      toast.undo('Pass unvoided', onUndo);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(await toastOf('Could not undo')).toHaveTextContent('Too late.');
  });

  it('dismisses a toast by id', async () => {
    renderToaster();
    let id: string | number | undefined;
    act(() => {
      id = toast.undo('Pass unvoided', () => undefined);
    });
    await screen.findByText('Pass unvoided');
    act(() => toast.dismiss(id));
    await waitFor(() => expect(screen.queryByText('Pass unvoided')).toBeNull());
    expect(() => toast.dismiss(undefined)).not.toThrow();
  });
});
