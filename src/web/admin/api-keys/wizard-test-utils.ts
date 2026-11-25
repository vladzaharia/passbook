import { within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Press Next in the New API key wizard (or Review, once the steps after it are done). */
export const next = (user: UserEvent, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole('button', { name: /^(Next|Review)$/ }));

const HEADINGS = ['Name the key', 'What it can do', 'Where it works', 'Check and create'];

/** Press Next (or Review) until the Review step shows; each step must already be valid. */
export async function toReview(user: UserEvent, dialog: HTMLElement) {
  for (let i = 0; i < HEADINGS.length - 1; i += 1) {
    const here = HEADINGS.findIndex((h) => within(dialog).queryByRole('heading', { name: h }));
    if (here === HEADINGS.length - 1) return;
    const jump = within(dialog).queryByRole('button', { name: 'Review' }) !== null;
    await next(user, dialog);
    await within(dialog).findByRole('heading', {
      name: jump ? HEADINGS[HEADINGS.length - 1] : HEADINGS[here + 1],
    });
  }
}

/** Press Create key on the Review step. */
export const createKey = (user: UserEvent, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole('button', { name: 'Create key' }));
