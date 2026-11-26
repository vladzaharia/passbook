import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Sheet } from '../ui/sheet.tsx';
import { BenchCode, parseBody } from './code-block.tsx';

beforeAll(() => {
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
  vi.useRealTimers();
});

const PASS = '01938a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b';

describe('a body in the bench', () => {
  it('draws JSON as the tree under the one block header, each id an IdChip', () => {
    render(
      <BenchCode
        label="Response"
        body={JSON.stringify({ id: PASS, status: 'active' })}
        empty="No body"
      />,
    );
    const block = document.querySelector('.code.bench-code') as HTMLElement;
    expect(within(block).getByText('Response').className).toBe('code-label');
    expect(within(block).getAllByRole('button', { name: 'Copy response' })).toHaveLength(1);
    const tree = screen.getByRole('region', { name: 'Response' });
    expect(within(tree).getByRole('button', { name: `Copy object id ${PASS}` })).toBeTruthy();
    expect(within(tree).getByRole('button', { name: 'Open object' })).toBeTruthy();
  });

  it('draws anything else as lines, and an absent body as one quiet line', () => {
    const { rerender } = render(
      <BenchCode label="Request" body="[redacted: 2 MB]" empty="No body" />,
    );
    expect(parseBody('[redacted: 2 MB]')).toBeUndefined();
    expect(screen.getByRole('region', { name: 'Request' }).textContent).toContain(
      '[redacted: 2 MB]',
    );
    rerender(<BenchCode label="Request" body={null} empty="No body" />);
    expect(screen.getByText('No body').tagName).toBe('P');
    expect(document.querySelector('.code')).toBeNull();
  });
});

describe('the sheet', () => {
  it('gives each sheet its own title id', () => {
    render(
      <>
        <Sheet title="One" onClose={vi.fn()}>
          a
        </Sheet>
        <Sheet title="Two" onClose={vi.fn()}>
          b
        </Sheet>
      </>,
    );
    const [one, two] = screen.getAllByRole('dialog');
    expect(one?.getAttribute('aria-labelledby')).not.toBe(two?.getAttribute('aria-labelledby'));
    expect(screen.getByRole('dialog', { name: 'Two' })).toBe(two);
  });

  it('plays its way out before it closes; under reduced motion it closes at once', () => {
    vi.useFakeTimers();
    const motion = (reduce: boolean) =>
      vi.stubGlobal('matchMedia', (q: string) => ({
        matches: q.includes('reduce') ? reduce : false,
      }));
    motion(false);
    const onClose = vi.fn();
    render(
      <Sheet title="New key" onClose={onClose}>
        body
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog', { name: 'New key' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(dialog.hasAttribute('data-closing')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.animationEnd(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    motion(true);
    const now = vi.fn();
    render(
      <Sheet title="Roll" onClose={now}>
        body
      </Sheet>,
    );
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(now).toHaveBeenCalledTimes(1);
  });
});
