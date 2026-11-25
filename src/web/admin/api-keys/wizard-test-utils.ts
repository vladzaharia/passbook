import { within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Press Next in the New API key wizard. */
export const next = (user: UserEvent, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole('button', { name: 'Next' }));

/** Press Next from Basics through to the Review step; each step must already be valid. */
export async function toReview(user: UserEvent, dialog: HTMLElement) {
  for (const heading of ['What it can do', 'Where it works', 'Check and create']) {
    await next(user, dialog);
    await within(dialog).findByRole('heading', { name: heading });
  }
}

/** Press Create key on the Review step. */
export const createKey = (user: UserEvent, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole('button', { name: 'Create key' }));
