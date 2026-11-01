import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../lib/test-utils.tsx';
import { ConfirmDialog } from './alert-dialog.tsx';
import { DropdownMenuItem } from './dropdown-menu.tsx';
import { MoreMenu } from './more-menu.tsx';

function Harness({ onPick = () => {} }: { onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MoreMenu>
        <DropdownMenuItem onSelect={onPick}>Copy</DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={() => setOpen(true)}>
          Delete
        </DropdownMenuItem>
      </MoreMenu>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={() => {}}
      />
    </>
  );
}

describe('MoreMenu', () => {
  it('opens a menu from the More button and runs an item', async () => {
    const user = userEvent.setup();
    const pick = vi.fn();
    const { container } = render(<Harness onPick={pick} />);
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect((await axe(await screen.findByRole('menu'))).violations).toEqual([]);
    await user.click(screen.getByRole('menuitem', { name: 'Copy' }));
    expect(pick).toHaveBeenCalledOnce();
  });

  it('returns focus to More after a dialog opened from an item closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const more = screen.getByRole('button', { name: 'More' });
    await user.click(more);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(more).toHaveFocus());
  });
});
