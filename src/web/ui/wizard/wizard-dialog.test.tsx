import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import '../../lib/test-utils.tsx';
import { FormField } from '../field.tsx';
import { Input } from '../input.tsx';
import { useWizard } from './use-wizard.ts';
import { WizardDialog } from './wizard-dialog.tsx';
import { WizardResult } from './wizard-result.tsx';
import { WizardReview } from './wizard-review.tsx';

type Id = 'name' | 'ips' | 'review';
const STEPS = [
  { id: 'name', title: 'Basics', heading: 'Name it' },
  { id: 'ips', title: 'Limits', heading: 'Where it works' },
  { id: 'review', title: 'Review', heading: 'Check and create' },
] as const;

function Harness({ failWith }: { failWith?: ApiError }) {
  const [name, setName] = useState('');
  const [ips, setIps] = useState('');
  const [done, setDone] = useState(false);
  const w = useWizard<Id>({
    open: true,
    steps: STEPS.map((s) => ({ ...s, summary: s.id === 'name' ? name : undefined })),
    errors: {
      name: name ? undefined : { name: 'Required.' },
      ips: ips ? undefined : { ips: 'Required.' },
    },
    hints: { name: 'Name it.' },
    fieldStep: { name: 'name', ips: 'ips' },
    onFinish: () => {
      if (failWith) throw failWith;
      setDone(true);
    },
  });
  return (
    <WizardDialog
      open
      onOpenChange={() => undefined}
      title="New thing"
      wizard={w}
      finishLabel="Create thing"
      result={
        done ? (
          <WizardResult title="Copy it">
            <p>The secret</p>
          </WizardResult>
        ) : undefined
      }
    >
      {w.id === 'name' ? (
        <FormField label="Name" required error={w.errors.name}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </FormField>
      ) : null}
      {w.id === 'ips' ? (
        <FormField label="IPs" required error={w.errors.ips}>
          {(p) => <Input {...p} value={ips} onChange={(e) => setIps(e.target.value)} />}
        </FormField>
      ) : null}
      {w.id === 'review' ? (
        <WizardReview
          sections={[
            { id: 'name', title: 'Basics', items: [{ label: 'Name', value: name }] },
            { id: 'ips', title: 'Limits', items: [{ label: 'IPs', value: ips }] },
          ]}
          onEdit={w.go}
        />
      ) : null}
    </WizardDialog>
  );
}

const dialog = () => screen.getByRole('dialog');
const button = (name: string | RegExp) => within(dialog()).getByRole('button', { name });

async function through(user: ReturnType<typeof userEvent.setup>) {
  await user.type(within(dialog()).getByLabelText(/Name/), 'CI');
  await user.click(button('Next'));
  await user.type(await within(dialog()).findByLabelText(/IPs/), '10.0.0.1');
  await user.click(button('Next'));
  await within(dialog()).findByRole('heading', { name: 'Check and create' });
}

describe('WizardDialog', () => {
  it('soft-disables Next: focusable, described by its hint, and a press shows and announces the errors', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const next = button('Next');
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(next).not.toBeDisabled();
    expect(next).toHaveAccessibleDescription('Name it.');
    next.focus();
    expect(next).toHaveFocus();
    expect(within(dialog()).queryByText('Required.')).toBeNull();
    await user.click(next);
    expect(await within(dialog()).findByText('Required.')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog()).getByLabelText(/Name/)).toHaveFocus());
    await waitFor(() =>
      expect(within(dialog()).getByRole('status')).toHaveTextContent('1 field needs attention'),
    );
    expect(within(dialog()).getByRole('heading', { name: 'Name it' })).toBeInTheDocument();
  });

  it('presses Next on Enter in a field, and Enter on a blocked step shows the errors', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = within(dialog()).getByLabelText(/Name/);
    expect(field).toHaveAttribute('enterkeyhint', 'next');
    await user.click(field);
    await user.keyboard('{Enter}');
    expect(await within(dialog()).findByText('Required.')).toBeInTheDocument();
    await user.type(field, 'CI{Enter}');
    expect(await within(dialog()).findByRole('heading', { name: 'Where it works' })).toHaveFocus();
  });

  it('scrolls the dialog body to the top on a step change', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(within(dialog()).getByLabelText(/Name/), 'CI');
    const body = dialog().querySelector<HTMLElement>('[data-dialog-body]');
    expect(body).not.toBeNull();
    if (!body) return;
    body.scrollTop = 120;
    await user.click(button('Next'));
    await within(dialog()).findByRole('heading', { name: 'Where it works' });
    expect(body.scrollTop).toBe(0);
  });

  it('keeps passed steps done and sends Edit from Review back through Review', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await through(user);
    await user.click(button('Edit basics'));
    await within(dialog()).findByRole('heading', { name: 'Name it' });
    // The Limits step was passed: it stays a button on the rail, and the primary reads Review.
    const rail = within(dialog()).getByRole('navigation', { name: 'Steps' });
    expect(within(rail).getByRole('button', { name: 'Limits' })).toBeInTheDocument();
    expect(within(dialog()).queryByRole('button', { name: 'Next' })).toBeNull();
    await user.click(button('Review'));
    expect(
      await within(dialog()).findByRole('heading', { name: 'Check and create' }),
    ).toBeInTheDocument();
  });

  it('shows a field the steps do not own as a line on the step', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        failWith={new ApiError({ status: 422, code: 'x', fields: { mode: 'Not allowed here.' } })}
      />,
    );
    await through(user);
    await user.click(button('Create thing'));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Not allowed here.');
    expect(within(dialog()).getByRole('heading', { name: 'Check and create' })).toBeInTheDocument();
  });

  it('jumps to the step that owns a server field', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        failWith={new ApiError({ status: 422, code: 'x', fields: { ips: 'Blocked range.' } })}
      />,
    );
    await through(user);
    await user.click(button('Create thing'));
    expect(await within(dialog()).findByText('Blocked range.')).toBeInTheDocument();
    expect(within(dialog()).getByRole('heading', { name: 'Where it works' })).toBeInTheDocument();
  });

  it('shows the rail from 43.5rem of frame width and the compact header below, by container query', () => {
    render(<Harness />);
    const nav = within(dialog()).getByRole('navigation', { name: 'Steps' });
    expect(nav.className).toContain('@[43.5rem]:w-52');
    expect(nav.querySelector('ol')?.className).toContain('@[43.5rem]:flex');
    expect(nav.querySelector('ol')?.className).toContain('hidden');
    expect(nav.firstElementChild?.className).toContain('@[43.5rem]:hidden');
    expect(nav.firstElementChild).toHaveTextContent('Step 1 of 3 · Basics');
    expect(dialog().className).toContain('sm:max-w-4xl');
    expect(dialog().querySelector('.\\@container')).not.toBeNull();
  });

  it('hands over the result in an md dialog with its own title, no X, and Esc ignored', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await through(user);
    await user.click(button('Create thing'));
    const reveal = await screen.findByRole('dialog', { name: /Copy it/ });
    expect(reveal.className).toContain('sm:max-w-lg');
    expect(within(reveal).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(reveal).getByText('The secret')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: /Copy it/ })).toBeInTheDocument();
    await waitFor(() => expect(reveal.querySelector('h2 [tabindex="-1"]')).toHaveFocus());
  });
});
