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
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';
import { FormField } from './field.tsx';
import { Form, useFormErrors } from './form.tsx';
import { Input } from './input.tsx';
import {
  SaveBar,
  type SaveResult,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from './save-bar.tsx';
import { SaveBarGroup, useSavedToast } from './save-bar-group.tsx';
import { toast } from './toaster.tsx';

type Outcome = 'ok' | 'refuse' | 'fail';
type Server = (value: string) => Promise<Outcome>;

/** One field, required; the server answers ok, refuses the value or fails. */
function TestForm({ name, server }: { name: string; server: Server }) {
  const [base, setBase] = useState(`${name} 0`);
  const [value, setValue] = useState(base);
  const [saving, setSaving] = useState(false);
  const [taken, setTaken] = useState<string>();
  const check = useFormErrors({ value: value.trim() ? undefined : 'Required.' });
  const dirty = value !== base;
  const guard = useUnsavedChangesGuard(dirty);
  const saved = useSavedToast();
  const id = `form-${name}`;
  async function save(): Promise<SaveResult> {
    setSaving(true);
    const outcome = await server(value);
    setSaving(false);
    if (outcome === 'ok') {
      setBase(value);
      check.reset();
      saved(`${name} saved`);
      return 'saved';
    }
    if (outcome === 'refuse') {
      setTaken('Taken.');
      return 'refused';
    }
    toast.error(new Error('Down.'), 'Could not save');
    return 'failed';
  }
  return (
    <Form id={id} {...check.form} onValid={save}>
      <FormField label={name} error={taken ?? check.errors.value}>
        {(p) => (
          <Input
            {...p}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setTaken(undefined);
            }}
          />
        )}
      </FormField>
      <SaveBar
        dirty={dirty}
        saving={saving}
        formId={id}
        onDiscard={() => {
          setValue(base);
          setTaken(undefined);
          check.reset();
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Form>
  );
}

function setup(page: ReactNode) {
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <>
        {page}
        <Link to={'/other' as never}>Leave</Link>
      </>
    ),
  });
  const other = createRoute({
    getParentRoute: () => root,
    path: '/other',
    component: () => <h1>Other</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, other]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const ok: Server = async () => 'ok';
const bars = () => screen.queryAllByRole('region', { name: 'Unsaved changes' });
/** The polite summary renders a frame after the errors. */
const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

function grouped(a: Server = ok, b: Server = ok) {
  return setup(
    <SaveBarGroup>
      <TestForm name="Alpha" server={a} />
      <TestForm name="Beta" server={b} />
    </SaveBarGroup>,
  );
}

async function editBoth(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Alpha'), 'x');
  await user.type(screen.getByLabelText('Beta'), 'y');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SaveBarGroup', () => {
  it('shows one bar for two dirty forms', async () => {
    const user = userEvent.setup();
    grouped();
    await user.type(await screen.findByLabelText('Alpha'), 'x');
    expect(bars()).toHaveLength(1);
    await user.type(screen.getByLabelText('Beta'), 'y');
    expect(bars()).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  });

  it('saves both top to bottom with one Saved toast', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    const calls: string[] = [];
    const record: Server = async (v) => {
      calls.push(v);
      return 'ok';
    };
    grouped(record, record);
    await editBoth(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toEqual(['Alpha 0x', 'Beta 0y']));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(success).toHaveBeenCalledWith('Saved');
    await waitFor(() => expect(bars()).toHaveLength(0));
    expect(screen.getByLabelText('Alpha')).toHaveValue('Alpha 0x');
  });

  it('discards both', async () => {
    const user = userEvent.setup();
    grouped();
    await editBoth(user);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Alpha')).toHaveValue('Alpha 0');
    expect(screen.getByLabelText('Beta')).toHaveValue('Beta 0');
    expect(bars()).toHaveLength(0);
  });

  it('saves the valid form and focuses the refused one, announcing once', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    const beta = vi.fn(ok);
    grouped(ok, beta);
    await user.clear(await screen.findByLabelText('Alpha'));
    await user.type(screen.getByLabelText('Beta'), 'y');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(beta).toHaveBeenCalledWith('Beta 0y'));
    expect(screen.getByText('Required.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Alpha')).toHaveFocus());
    await nextFrame();
    expect(screen.getAllByText('1 field needs attention')).toHaveLength(1);
    // Beta is saved; Alpha keeps its change and the bar.
    expect(screen.getByLabelText('Beta')).toHaveValue('Beta 0y');
    expect(bars()).toHaveLength(1);
    expect(success).not.toHaveBeenCalled();
  });

  it('focuses a field the server refused', async () => {
    const user = userEvent.setup();
    grouped(async () => 'refuse');
    await editBoth(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Taken.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Alpha')).toHaveFocus());
  });

  it('keeps a failed form dirty with its error while the other saves', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    const error = vi.spyOn(toast, 'error');
    grouped(ok, async () => 'fail');
    await editBoth(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(success).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    // Only Beta still had a change: Alpha's saved value stays.
    expect(screen.getByLabelText('Alpha')).toHaveValue('Alpha 0x');
    expect(screen.getByLabelText('Beta')).toHaveValue('Beta 0');
  });

  it('saves the page on Enter in either form', async () => {
    const user = userEvent.setup();
    const beta = vi.fn(ok);
    grouped(ok, beta);
    await editBoth(user);
    await user.type(screen.getByLabelText('Alpha'), '{Enter}');
    await waitFor(() => expect(beta).toHaveBeenCalledOnce());
    await waitFor(() => expect(bars()).toHaveLength(0));
  });

  it('asks once before leaving with two dirty forms', async () => {
    const user = userEvent.setup();
    const router = grouped();
    await editBoth(user);
    await user.click(screen.getByRole('link', { name: 'Leave' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/other'));
  });
});

describe('SaveBar without a group', () => {
  it('keeps one bar, toast and Save per form', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    const beta = vi.fn(ok);
    setup(
      <>
        <TestForm name="Alpha" server={ok} />
        <TestForm name="Beta" server={beta} />
      </>,
    );
    await editBoth(user);
    expect(bars()).toHaveLength(2);
    await user.click(within(bars()[0] as HTMLElement).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Alpha saved'));
    expect(beta).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Alpha'), 'z');
    await user.clear(screen.getByLabelText('Alpha'));
    await user.click(within(bars()[0] as HTMLElement).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByLabelText('Alpha')).toHaveFocus());
  });
});
