import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ApiError } from '../lib/errors.ts';
import '../lib/test-utils.tsx';
import { ConfirmDialog } from './alert-dialog.tsx';
import { Button } from './button.tsx';
import { CommandPalette } from './command-palette.tsx';
import { Dialog, DialogContent, DialogTrigger } from './dialog.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu.tsx';
import { SaveBar, UnsavedChangesDialog, useUnsavedChangesGuard } from './save-bar.tsx';
import { Sheet, SheetContent, SheetTrigger } from './sheet.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.tsx';

describe('Dialog', () => {
  it('traps focus, closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent title="Rename" description="Pick a name" footer={<Button>Save</Button>}>
          <input aria-label="Name" />
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Rename' });
    expect(dialog).toHaveAccessibleDescription('Pick a name');
    expect((await axe(dialog)).violations).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  function Harness({ onConfirm }: { onConfirm: () => void | Promise<void> }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <span data-testid="state">{open ? 'open' : 'closed'}</span>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Delete pass?"
          description="This cannot be undone."
          confirmLabel="Delete"
          destructive
          onConfirm={onConfirm}
        />
      </>
    );
  }

  it('is an alertdialog and focuses the safe action first', async () => {
    render(<Harness onConfirm={() => {}} />);
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete pass?' });
    expect((await axe(dialog)).violations).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('does not close on outside click but closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => {}} />);
    await screen.findByRole('alertdialog');
    await user.click(document.querySelector('.bg-black\\/60') as HTMLElement);
    expect(screen.getByTestId('state')).toHaveTextContent('open');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('closed'));
  });

  it('shows loading during an async confirm, then closes', async () => {
    const user = userEvent.setup();
    let resolve: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<Harness onConfirm={onConfirm} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => resolve());
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('closed'));
  });

  it('stays open with an inline error when confirm fails', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {
      throw new ApiError({ status: 409, code: 'conflict', detail: 'Pass changed. Reload.' });
    });
    render(<Harness onConfirm={onConfirm} />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pass changed. Reload.');
    expect(screen.getByTestId('state')).toHaveTextContent('open');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});

describe('Sheet', () => {
  it('opens as a labelled dialog and closes with Escape', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Menu</Button>
        </SheetTrigger>
        <SheetContent side="left" title="Navigation">
          <a href="#a">Link</a>
        </SheetContent>
      </Sheet>,
    );
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    const sheet = await screen.findByRole('dialog', { name: 'Navigation' });
    expect((await axe(sheet)).violations).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('DropdownMenu', () => {
  it('opens with the keyboard, navigates and activates an item', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Copy link</DropdownMenuItem>
          <DropdownMenuItem destructive onSelect={onSelect}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

describe('Tabs', () => {
  it('switches with arrow keys and has no a11y violations', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Tabs defaultValue="fields">
        <TabsList aria-label="Pass sections">
          <TabsTrigger value="fields">Fields</TabsTrigger>
          <TabsTrigger value="holder">Holder</TabsTrigger>
        </TabsList>
        <TabsContent value="fields">Fields panel</TabsContent>
        <TabsContent value="holder">Holder panel</TabsContent>
      </Tabs>,
    );
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Holder' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Holder panel');
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('CommandPalette', () => {
  function Harness({ onGo }: { onGo: (id: string) => void }) {
    const [open, setOpen] = useState(true);
    const [query, setQuery] = useState('');
    return (
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        query={query}
        onQueryChange={setQuery}
        groups={[
          {
            heading: 'Go to',
            items: [
              { id: 'passes', label: 'Passes', onSelect: () => onGo('passes') },
              { id: 'users', label: 'Users', onSelect: () => onGo('users') },
            ],
          },
          {
            heading: 'Passes',
            items: [{ id: 'p1', label: 'Remote hit', remote: true, onSelect: () => onGo('p1') }],
          },
        ]}
      />
    );
  }

  it('filters local items, always shows remote ones, and runs the selected item', async () => {
    const user = userEvent.setup();
    const onGo = vi.fn();
    render(<Harness onGo={onGo} />);
    const input = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(input, 'use');
    expect(screen.queryByRole('option', { name: 'Passes' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Remote hit' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onGo).toHaveBeenCalledWith('users');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('has an accessible name and closes with Escape', async () => {
    const user = userEvent.setup();
    render(<Harness onGo={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect((await axe(dialog)).violations).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('SaveBar', () => {
  it('renders only while dirty and wires both actions', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const { rerender } = render(<SaveBar dirty={false} onSave={onSave} onDiscard={onDiscard} />);
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    rerender(<SaveBar dirty onSave={onSave} onDiscard={onDiscard} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('disables actions while saving', () => {
    render(<SaveBar dirty saving onSave={() => {}} onDiscard={() => {}} />);
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('useUnsavedChangesGuard', () => {
  function setup(dirty: boolean) {
    function Form() {
      const guard = useUnsavedChangesGuard(dirty);
      return (
        <div>
          <h1>Form</h1>
          <Link to="/other">Leave</Link>
          <UnsavedChangesDialog blocker={guard} />
        </div>
      );
    }
    const root = createRootRoute({ component: Outlet });
    const form = createRoute({ getParentRoute: () => root, path: '/', component: Form });
    const other = createRoute({ getParentRoute: () => root, path: '/other', component: () => <h1>Other</h1> });
    const router = createRouter({
      routeTree: root.addChildren([form, other]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(<RouterProvider router={router} />);
    return router;
  }

  it('blocks navigation while dirty and keeps the user on the page when they keep editing', async () => {
    const user = userEvent.setup();
    const router = setup(true);
    await user.click(await screen.findByRole('link', { name: 'Leave' }));
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/');
  });

  it('navigates after the user discards', async () => {
    const user = userEvent.setup();
    const router = setup(true);
    await user.click(await screen.findByRole('link', { name: 'Leave' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/other'));
  });

  it('does not block when clean', async () => {
    const user = userEvent.setup();
    const router = setup(false);
    await user.click(await screen.findByRole('link', { name: 'Leave' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/other'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
