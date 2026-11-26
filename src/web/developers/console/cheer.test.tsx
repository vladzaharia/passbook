import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpConsole } from './app/console.tsx';
import { resetBudget } from './budget.ts';
import { cheersFor, resetCheer } from './cheer.ts';
import { fakeNetwork, json, passesCreate } from './test-support.ts';
import { resetToken } from './token.ts';

const props = {
  origin: 'https://x',
  csrf: 'c',
  templateId: null,
  codes: new Set<string>(),
} as const;
const run = () => userEvent.click(screen.getByRole('button', { name: 'Run' }));

beforeEach(() => {
  resetToken();
  resetBudget();
  resetCheer();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('the first 2xx of a session', () => {
  it('cheers once, and never on a 4xx', () => {
    expect(cheersFor(404)).toBe(false);
    expect(cheersFor(500)).toBe(false);
    expect(cheersFor(201)).toBe(true);
    expect(cheersFor(200)).toBe(false);
  });

  it('still cheers once when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(cheersFor(200)).toBe(true);
    expect(cheersFor(200)).toBe(false);
    vi.restoreAllMocks();
  });

  it('the buddy waves on the console after the first 2xx only', async () => {
    fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    const { container } = render(<OpConsole op={passesCreate} mode="console" {...props} />);
    await run();
    await screen.findByText('201 Created');
    await vi.waitFor(() =>
      expect(container.querySelector('.cr-cheer .wl-buddy')?.getAttribute('data-scene')).toBe(
        'wave',
      ),
    );
    await run();
    await vi.waitFor(() => expect(container.querySelector('.cr-cheer')).toBeNull());
  });

  it('does not wave for a 4xx, and not on a reference page', async () => {
    fakeNetwork(() => json({ code: 'X' }, { status: 422 }));
    const { container, unmount } = render(
      <OpConsole op={passesCreate} mode="console" {...props} />,
    );
    await run();
    await screen.findByText('422 Unprocessable');
    expect(container.querySelector('.cr-cheer')).toBeNull();
    unmount();
    fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    const op = render(<OpConsole op={passesCreate} mode="op" {...props} />);
    await run();
    await screen.findByText('201 Created');
    expect(op.container.querySelector('.cr-cheer')).toBeNull();
  });

  it('is still under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    const { container } = render(<OpConsole op={passesCreate} mode="console" {...props} />);
    await run();
    await vi.waitFor(() =>
      expect(container.querySelector('.cr-cheer')?.getAttribute('data-still')).toBe('true'),
    );
  });
});
