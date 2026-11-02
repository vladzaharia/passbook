import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../lib/test-utils.tsx';
import { Button } from './button.tsx';
import { Checkbox, CheckboxField } from './checkbox.tsx';
import { Combobox } from './combobox.tsx';
import { FormField } from './field.tsx';
import { IconButton } from './icon-button.tsx';
import { Input, Textarea } from './input.tsx';
import { RadioGroup } from './radio-group.tsx';
import { Select } from './select.tsx';
import { Switch } from './switch.tsx';
import { TooltipProvider } from './tooltip.tsx';

const noViolations = async (container: HTMLElement) => {
  expect((await axe(container)).violations).toEqual([]);
};

describe('Button', () => {
  it('swaps its variant without a colour transition, then transitions again', async () => {
    const { rerender } = render(<Button variant="primary">New pass</Button>);
    const button = screen.getByRole('button', { name: 'New pass' });
    expect(button).not.toHaveAttribute('data-instant');
    rerender(<Button variant="outline">New pass</Button>);
    expect(button).toHaveAttribute('data-instant');
    await waitFor(() => expect(button).not.toHaveAttribute('data-instant'));
  });

  it('renders icons around an asChild child', () => {
    render(
      <Button asChild iconStart={<svg data-testid="ic" />}>
        <a href="/x">Go</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Go' });
    expect(link.firstElementChild).toBe(screen.getByTestId('ic'));
    expect(link.textContent).toBe('Go');
  });

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
    // The error replaces the help and is linked by aria-describedby, never role=alert.
    expect(input).toHaveAccessibleDescription('Invalid email');
    expect(screen.queryByText('Used for sign-in')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
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
    const trigger = screen.getByRole('combobox', { name: 'Org: Select' });
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
    render(
      <Combobox
        aria-label="Org"
        options={[{ value: '1', label: 'Henrys' }]}
        onValueChange={() => {}}
      />,
    );
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
