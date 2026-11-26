import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { next } from './wizard-test-utils.ts';

vi.mock('@/shared/contracts/api-keys.ts', async (orig) => ({
  ...(await orig<typeof import('@/shared/contracts/api-keys.ts')>()),
  MINTABLE_PLATFORM_SCOPES: [],
}));

it('hides the Platform option while no platform scope is mintable', async () => {
  await renderApp('/admin/platform/api-keys', {
    session: 'admin',
    handlers: { '/api/v1/api-keys': () => json({ items: [], nextCursor: null, revokedCount: 0 }) },
  });
  const user = userEvent.setup();
  await screen.findByText('No API keys');
  await user.click(screen.getByRole('button', { name: 'New API key' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/Name/), 'Ops');
  await next(user, dialog);
  await within(dialog).findByRole('heading', { name: 'What it can do' });
  expect(within(dialog).queryByRole('radio', { name: 'Platform' })).toBeNull();
  expect(within(dialog).queryByRole('radiogroup', { name: 'Reaches' })).toBeNull();
  expect(within(dialog).getByRole('checkbox', { name: 'Read passes' })).toBeChecked();
});
