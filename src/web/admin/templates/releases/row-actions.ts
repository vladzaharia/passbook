import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/** The list paints at once; its badges and Restore wait for the release lists. */
export const releasesLoaded = () =>
  waitFor(() => expect(screen.queryByText('Loading releases')).not.toBeInTheDocument());

/** Opens a version row's menu and picks an action. */
export async function pickRowAction(user: UserEvent, version: string, action: string) {
  await releasesLoaded();
  await user.click(await screen.findByRole('button', { name: `Actions for ${version}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}
