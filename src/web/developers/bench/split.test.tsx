import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BenchSplit } from './split.tsx';

beforeAll(() => {
  // jsdom has no modal dialogs.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** `wide`: the 1180 px query matches; reduced motion so a close is immediate. */
const media = (wide: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('1180') ? wide : q.includes('reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

const split = (open: boolean, onClose = vi.fn(), layout?: 'split' | 'index') =>
  render(
    <BenchSplit
      layout={layout}
      main={<button type="button">Row</button>}
      pane={<p>Detail</p>}
      open={open}
      onClose={onClose}
      label="Request"
    />,
  );

describe('the bench body', () => {
  it('puts the pane beside the list from 1180 px, as a named region', () => {
    media(true);
    const { container } = split(false);
    expect(screen.getByRole('complementary', { name: 'Request' }).textContent).toBe('Detail');
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('.bench-split')?.getAttribute('data-layout')).toBe('split');
  });

  it('puts the console index first', () => {
    media(true);
    const { container } = split(false, vi.fn(), 'index');
    expect(container.querySelector('.bench-split > :first-child')?.className).toBe('bench-pane');
  });

  it('below 1180 px opens the pane as a dialog from its edge, and gives focus back on close', () => {
    media(false);
    const onClose = vi.fn();
    const view = (open: boolean) => (
      <BenchSplit
        main={<button type="button">Row</button>}
        pane={<p>Detail</p>}
        open={open}
        onClose={onClose}
        label="Request"
      />
    );
    const { container, rerender } = render(view(false));
    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(false);
    expect(dialog.dataset.edge).toBe('end');
    const row = screen.getByRole('button', { name: 'Row' });
    row.focus();
    rerender(view(true));
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('Request');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(3);
    act(() => rerender(view(false)));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(row);
  });
});
