import { readFileSync } from 'node:fs';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ApiError } from '../lib/errors.ts';
import '../lib/test-utils.tsx';
import { ConfirmDialog } from './alert-dialog.tsx';
import { Button } from './button.tsx';
import { CommandPalette, matchLabel } from './command-palette.tsx';
import { Dialog, DialogContent, DialogTrigger } from './dialog.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu.tsx';
import { OVERLAY_TITLE } from './overlay.tsx';
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

describe('Dialog dirty', () => {
  function Harness({ dirty }: { dirty: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>New organization</Button>
        <Dialog open={open} dirty={dirty} onOpenChange={setOpen}>
          <DialogContent
            title="New organization"
            footer={
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            }
          >
            <input aria-label="Name" data-autofocus />
          </DialogContent>
        </Dialog>
      </>
    );
  }
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'New organization' }));
    return screen.findByRole('dialog', { name: 'New organization' });
  };

  it('asks before Esc, an outside click or X close it, and stays on Keep editing', async () => {
    const user = userEvent.setup();
    render(<Harness dirty />);
    await open(user);
    const ask = async (close: () => Promise<void>) => {
      await close();
      const confirm = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
      await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      // Back in the form, where the user was.
      const dialog = screen.getByRole('dialog', { name: 'New organization' });
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    };
    await ask(() => user.keyboard('{Escape}'));
    await ask(() => user.click(screen.getByRole('button', { name: 'Close' })));
    await ask(async () => {
      const overlay = document.querySelector('.wl-overlay');
      if (overlay) await user.pointer({ target: overlay, keys: '[MouseLeft]' });
    });
  });

  it('closes on Discard and returns focus to the opener; Cancel closes without asking', async () => {
    const user = userEvent.setup();
    render(<Harness dirty />);
    await open(user);
    await user.keyboard('{Escape}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    // Above the dialog it confirms for, so its scrim dims that dialog too.
    expect(confirm.className).toContain('z-[70]');
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New organization' })).toHaveFocus(),
    );
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('closes at once when clean', async () => {
    const user = userEvent.setup();
    render(<Harness dirty={false} />);
    await open(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('Dialog autofocus', () => {
  it('focuses a field marked data-autofocus instead of the close button', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Delete</Button>
        </DialogTrigger>
        <DialogContent title="Delete pass?" footer={<Button>Delete pass</Button>}>
          <input aria-label="Type delete to confirm" data-autofocus />
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Type delete to confirm')).toHaveFocus();
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

  it('is an alertdialog and focuses itself, never Cancel', async () => {
    render(<Harness onConfirm={() => {}} />);
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete pass?' });
    expect((await axe(dialog)).violations).toEqual([]);
    await waitFor(() => expect(dialog).toHaveFocus());
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
          <a href="#a">Open settings</a>
        </SheetContent>
      </Sheet>,
    );
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    const sheet = await screen.findByRole('dialog', { name: 'Navigation' });
    expect((await axe(sheet)).violations).toEqual([]);
    // One overlay title size: sheets read like dialogs (16 px, semibold).
    expect(screen.getByRole('heading', { name: 'Navigation' }).className).toContain(OVERLAY_TITLE);
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

  it('turns five tabs into a Section select on phones', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width: 639.98px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          {['a', 'b', 'c', 'd', 'e'].map((v) => (
            <TabsTrigger key={v} value={v}>
              {v.toUpperCase()}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>,
    );
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Section: A' })).toBeInTheDocument();
    vi.unstubAllGlobals();
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
            ].filter((i) => matchLabel(i.label, query)),
          },
          {
            heading: 'Passes',
            items: [{ id: 'p1', label: 'Remote hit', onSelect: () => onGo('p1') }],
          },
        ]}
      />
    );
  }

  it('shows the groups it is given and runs the selected item', async () => {
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
          <Link to={'/other' as never}>Leave</Link>
          <UnsavedChangesDialog blocker={guard} />
        </div>
      );
    }
    const root = createRootRoute({ component: Outlet });
    const form = createRoute({ getParentRoute: () => root, path: '/', component: Form });
    const other = createRoute({
      getParentRoute: () => root,
      path: '/other',
      component: () => <h1>Other</h1>,
    });
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
    expect(
      await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' }),
    ).toBeInTheDocument();
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

const cssBlock = (css: string, selector: string) =>
  css.match(new RegExp(`${selector.replace(/[[\]"().>]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('bottom sheets', () => {
  it('dims the screen behind a menu that opens as an action sheet', () => {
    const css = readFileSync('src/web/styles/kit-motion.css', 'utf8');
    const wrapper = '[data-radix-popper-content-wrapper]:has(> .wl-action-sheet)';
    expect(cssBlock(css, wrapper)).toMatch(/will-change:\s*auto !important/);
    const scrim = cssBlock(css, `${wrapper}::before`);
    expect(scrim).toMatch(/position:\s*fixed/);
    expect(scrim).toMatch(/inset:\s*0/);
    expect(scrim).toMatch(/background:\s*rgb\(0 0 0 \/ 0\.6\)/);
  });
});
