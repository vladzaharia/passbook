import { within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/** Presses Next until the dialog shows the button `name` (the finish, on Review). */
export async function reach(user: UserEvent, dialog: HTMLElement, name: string) {
  for (let i = 0; i < 8 && !within(dialog).queryByRole('button', { name }); i++)
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
  return within(dialog).getByRole('button', { name });
}

/** Presses Next until the step headed `heading`. */
export async function reachStep(user: UserEvent, dialog: HTMLElement, heading: string) {
  for (let i = 0; i < 8 && !within(dialog).queryByRole('heading', { name: heading }); i++)
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
  return within(dialog).getByRole('heading', { name: heading });
}

/** Next (or the finish) is soft-disabled: it carries aria-disabled and a press shows errors. */
export function expectBlocked(dialog: HTMLElement, name = 'Next') {
  expect(within(dialog).getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
}

/** The opposite: the button is live. */
export function expectReady(dialog: HTMLElement, name = 'Next') {
  expect(within(dialog).getByRole('button', { name })).not.toHaveAttribute('aria-disabled', 'true');
}
