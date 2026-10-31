import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { z } from 'zod';
import { ApiError } from '../lib/errors.ts';
import '../lib/test-utils.tsx';
import { Button } from './button.tsx';
import { Checkbox, CheckboxField } from './checkbox.tsx';
import { Combobox } from './combobox.tsx';
import { FormField } from './field.tsx';
import { applyApiErrors, RhfField, useZodForm } from './form.tsx';
import { IconButton } from './icon-button.tsx';
import { Input, Textarea } from './input.tsx';
import { RadioGroup } from './radio-group.tsx';
import { Select } from './select.tsx';
import { StatusPill } from './status-pill.tsx';
import { Switch } from './switch.tsx';
import { TooltipProvider } from './tooltip.tsx';

const noViolations = async (container: HTMLElement) => {
  expect((await axe(container)).violations).toEqual([]);
};

describe('Button', () => {
  it('activates with Enter and Space', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('is disabled and busy while loading, and ignores clicks', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: /save/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('defaults to type=button so it never submits a form by accident', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Cancel</Button>
      </form>,
    );
    await user.click(screen.getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('asChild keeps the link semantics and blocks click when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { container } = render(
      <Button asChild disabled onClick={onClick}>
        <a href="#x">Go</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Go' });
    expect(link).toHaveAttribute('aria-disabled', 'true');
    await user.click(link);
    expect(onClick).not.toHaveBeenCalled();
    await noViolations(container);
  });
});

describe('IconButton', () => {
  it('uses the label as its accessible name and shows it as a tooltip on focus', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TooltipProvider>
        <IconButton label="Delete" icon={<span aria-hidden>x</span>} />
      </TooltipProvider>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Delete');
    await noViolations(container);
  });
});

describe('FormField', () => {
  it('links label, help and error to the control', async () => {
    const { container } = render(
      <FormField label="Email" help="Used for sign-in" error="Invalid email" required>
        {(p) => <Input {...p} />}
      </FormField>,
    );
    const input = screen.getByLabelText(/email/i);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAccessibleDescription('Used for sign-in Invalid email');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid email');
    await noViolations(container);
  });

  it('has no alert and no aria-invalid without an error', () => {
    render(<FormField label="Name">{(p) => <Textarea {...p} />}</FormField>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
  });
});

describe('Select', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ];

  it('opens with the keyboard and selects an option', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { container } = render(
      <FormField label="Kind">
        {(p) => <Select {...p} options={options} onValueChange={onValueChange} />}
      </FormField>,
    );
    await noViolations(container);
    await user.tab();
    await user.keyboard('{Enter}');
    const option = await screen.findByRole('option', { name: 'Beta' });
    await user.click(option);
    expect(onValueChange).toHaveBeenCalledWith('b');
  });
});

describe('Combobox', () => {
  it('filters by typing and selects with Enter', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox
        aria-label="Org"
        options={[
          { value: '1', label: 'Henrys' },
          { value: '2', label: 'Acme' },
        ]}
        onValueChange={onValueChange}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Org' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    await user.keyboard('acm');
    expect(screen.queryByRole('option', { name: /henrys/i })).toBeNull();
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('2');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('shows the empty text when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Combobox aria-label="Org" options={[{ value: '1', label: 'Henrys' }]} onValueChange={() => {}} />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('zzz');
    expect(await screen.findByText('No results')).toBeInTheDocument();
  });
});

describe('Checkbox, Switch, RadioGroup', () => {
  it('toggle with Space', async () => {
    const user = userEvent.setup();
    const onChecked = vi.fn();
    const onSwitch = vi.fn();
    const { container } = render(
      <div>
        <CheckboxField label="Agree" onCheckedChange={onChecked} />
        <Switch aria-label="Enabled" onCheckedChange={onSwitch} />
      </div>,
    );
    await user.tab();
    await user.keyboard(' ');
    expect(onChecked).toHaveBeenCalledWith(true);
    await user.tab();
    await user.keyboard(' ');
    expect(onSwitch).toHaveBeenCalledWith(true);
    await noViolations(container);
  });

  it('checkbox reports indeterminate state', () => {
    render(<Checkbox checked="indeterminate" aria-label="All" />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'mixed');
  });

  it('radio group is a labelled group and moves with arrow keys', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [v, setV] = useState<string | undefined>('a');
      return (
        <RadioGroup
          legend="Delivery"
          value={v}
          onValueChange={setV}
          options={[
            { value: 'a', label: 'Email' },
            { value: 'b', label: 'Link' },
          ]}
        />
      );
    }
    const { container } = render(<Harness />);
    expect(screen.getByRole('group', { name: 'Delivery' })).toBeInTheDocument();
    await user.tab();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Link' })).toBeChecked();
    await noViolations(container);
  });
});

describe('forms with zod', () => {
  const schema = z.object({ name: z.string().min(1, 'Name is required'), age: z.coerce.number().min(18, 'Too young') });

  function Harness({ onValid, serverError }: { onValid: (v: unknown) => void; serverError?: ApiError }) {
    const form = useZodForm(schema, { name: '', age: 20 });
    return (
      <form
        onSubmit={form.handleSubmit(onValid, () => {})}
        noValidate
      >
        <RhfField control={form.control} name="name" label="Name">
          {(field, p) => <Input {...field} {...p} />}
        </RhfField>
        <RhfField control={form.control} name="age" label="Age">
          {(field, p) => <Input {...field} {...p} value={String(field.value)} />}
        </RhfField>
        <Button type="submit">Send</Button>
        <Button onClick={() => applyApiErrors(form, serverError)}>Apply server</Button>
      </form>
    );
  }

  it('shows field errors on invalid submit and does not call onValid', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(onValid).not.toHaveBeenCalled();
  });

  it('submits parsed output when valid', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onValid).toHaveBeenCalled());
    expect(onValid.mock.calls[0]?.[0]).toEqual({ name: 'Ada', age: 20 });
  });

  it('maps API field errors onto matching fields and ignores unknown ones', async () => {
    const user = userEvent.setup();
    const error = new ApiError({
      status: 422,
      code: 'validation_failed',
      fields: { name: 'Taken', unknown: 'x' },
    });
    render(<Harness onValid={() => {}} serverError={error} />);
    await user.click(screen.getByRole('button', { name: 'Apply server' }));
    expect(await screen.findByText('Taken')).toBeInTheDocument();
    expect(screen.queryByText('x')).toBeNull();
  });

  it('applyApiErrors returns false for non-API errors', () => {
    const setError = vi.fn();
    expect(applyApiErrors({ setError, getValues: () => ({}) }, new Error('x'))).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });
});

describe('StatusPill', () => {
  it.each([
    ['verified', 'Verified'],
    ['configured', 'Configured'],
    ['degraded', 'Degraded'],
    ['failing', 'Failing'],
    ['not_configured', 'Not configured'],
    ['active', 'Active'],
    ['voided', 'Voided'],
  ])('renders %s with text', async (status, text) => {
    const { container } = render(<StatusPill status={status} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    await noViolations(container);
  });

  it('falls back to neutral with the raw text for unknown keys', () => {
    render(<StatusPill status="mystery" />);
    expect(screen.getByText('mystery')).toBeInTheDocument();
  });
});
