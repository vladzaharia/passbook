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
  it('names what is missing on Create instead of a silent disabled button', async () => {
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
    expect(within(form).queryByLabelText('No opening time')).toBeNull();
    expect(within(form).queryByLabelText('No closing time')).toBeNull();
    const create = within(form).getByRole('button', { name: 'Create event' });
    expect(create).toBeEnabled();
    await user.click(create);
    expect(within(form).getByText('Enter a name.')).toBeInTheDocument();
    expect(within(form).getByText('Set when scanning opens.')).toBeInTheDocument();
    expect(within(form).getByText('Set when scanning closes.')).toBeInTheDocument();
    expect(creates).toBe(0);
  });
});
