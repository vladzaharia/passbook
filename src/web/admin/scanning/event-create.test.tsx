import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { memoryStorage, northwind, otherHandlers } from './staff-test-fixtures.ts';

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

describe('New event', () => {
  it('names what is missing on Next instead of a silent disabled button', async () => {
    let creates = 0;
    await renderApp('/admin/scanning?tab=events&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-events': (_url, init) => {
          if (init?.method === 'POST') creates += 1;
          return json({ items: [], nextCursor: null });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(
      (await screen.findAllByRole('button', { name: 'New event' }))[0] as HTMLElement,
    );
    const form = screen.getByRole('dialog', { name: 'New event' });
    expect(within(form).getByRole('heading', { name: 'Name the event' })).toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Create event' })).toBeNull();
    const next = within(form).getByRole('button', { name: 'Next' });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    await user.click(next);
    expect(within(form).getByText('Enter a name.')).toBeInTheDocument();
    await user.type(within(form).getByRole('textbox', { name: /^Name/ }), 'Summer');
    await user.click(within(form).getByRole('button', { name: 'Next' }));
    expect(within(form).getByRole('heading', { name: 'Pick the passes' })).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Next' }));
    expect(within(form).getByText('Pick at least one template.')).toBeInTheDocument();
    expect(creates).toBe(0);
  });
});
