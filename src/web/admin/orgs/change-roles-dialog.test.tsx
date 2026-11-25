import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ChangeRolesDialog } from './change-roles-dialog.tsx';
import { member } from './org-access-fixtures.ts';

describe('ChangeRolesDialog', () => {
  it('starts from the roles, saves the change and closes', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(
      <ChangeRolesDialog member={member()} name="Ada Lovelace" onClose={onClose} onSave={onSave} />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change roles for Ada Lovelace' });
    expect(within(dialog).getByRole('checkbox', { name: 'Template author' })).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(await axe(dialog)).toHaveNoViolations();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Pass operator' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'member-1' }), [
        'template_author',
      ]),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('stays open on the draft when the save fails', async () => {
    const onClose = vi.fn();
    render(
      <ChangeRolesDialog
        member={member()}
        name="Ada"
        onClose={onClose}
        onSave={async () => false}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Organization admin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('checkbox', { name: 'Organization admin' })).toBeChecked();
  });
});
