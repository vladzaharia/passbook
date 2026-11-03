import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../../lib/test-utils.tsx';
import { Card, TooltipProvider } from '../../../ui/index.ts';
import { describeSchema, type FormValues, validateValues } from './schema.ts';
import { SchemaForm } from './schema-form.tsx';

const schema = {
  type: 'object',
  required: ['name', 'level'],
  properties: {
    notes: { type: 'string', maxLength: 500, 'x-order': 30, 'x-group': 'Extra' },
    level: {
      type: 'string',
      enum: ['copper', 'blue'],
      'x-enumLabels': { copper: 'Copper club', blue: 'Blue club' },
      'x-label': 'Level',
      'x-order': 2,
      'x-group': 'Member',
    },
    name: {
      type: 'string',
      minLength: 2,
      'x-label': 'Full name',
      'x-order': 1,
      'x-group': 'Member',
      description: 'As printed.',
    },
    points: { type: 'integer', minimum: 0, maximum: 100 },
    active: { type: 'boolean', 'x-label': 'Active' },
    joined: { type: 'string', format: 'date' },
    email: { type: 'string', format: 'email' },
    site: { type: 'string', format: 'uri' },
    photo: { type: 'string', 'x-widget': 'image' },
  },
};

function Harness({
  initial = {},
  onValue,
  ...rest
}: {
  initial?: FormValues;
  onValue?: (v: FormValues) => void;
} & Partial<React.ComponentProps<typeof SchemaForm>>) {
  const [value, setValue] = useState<FormValues>(initial);
  return (
    <TooltipProvider>
      <SchemaForm
        schema={schema}
        value={value}
        onChange={(v) => {
          setValue(v);
          onValue?.(v);
        }}
        {...rest}
      />
    </TooltipProvider>
  );
}

describe('describeSchema', () => {
  it('orders by x-order then declaration and groups by x-group', () => {
    const groups = describeSchema(schema);
    expect(groups.map((g) => g.name)).toEqual(['Member', 'Extra', '']);
    expect(groups[0]?.fields.map((f) => f.key)).toEqual(['name', 'level']);
    expect(groups[2]?.fields.map((f) => f.key)).toEqual([
      'points',
      'active',
      'joined',
      'email',
      'site',
      'photo',
    ]);
  });

  it('infers widgets and enum labels', () => {
    const fields = describeSchema(schema).flatMap((g) => g.fields);
    const by = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(by.level?.widget).toBe('select');
    expect(by.level?.options).toEqual([
      { value: 'copper', label: 'Copper club' },
      { value: 'blue', label: 'Blue club' },
    ]);
    expect(by.points?.widget).toBe('number');
    expect(by.active?.widget).toBe('boolean');
    expect(by.joined?.widget).toBe('date');
    expect(by.email?.widget).toBe('email');
    expect(by.site?.widget).toBe('url');
    expect(by.notes?.widget).toBe('textarea');
    expect(by.photo?.widget).toBe('image');
    expect(by.points?.label).toBe('Points');
  });

  it('returns no groups for a non-object schema', () => {
    expect(describeSchema(null)).toEqual([]);
    expect(describeSchema({ type: 'string' })).toEqual([]);
  });
});

describe('validateValues', () => {
  it('flags required, length, range, enum, email, url and date', () => {
    const errors = validateValues(schema, {
      name: 'A',
      level: 'gold',
      points: 101,
      email: 'nope',
      site: 'ftp://x.test',
      joined: '12/01/2026',
    });
    expect(errors).toMatchObject({
      name: 'At least 2 characters.',
      level: 'Choose one of the listed values.',
      points: 'At most 100.',
      email: 'Enter a valid email address.',
      site: 'Enter an http(s) URL.',
      joined: 'Use YYYY-MM-DD.',
    });
  });

  it('reports missing required fields only', () => {
    expect(validateValues(schema, {})).toEqual({ name: 'Required.', level: 'Required.' });
  });

  it('accepts a valid set and a whole-number check', () => {
    expect(validateValues(schema, { name: 'Ann', level: 'blue', points: 5 })).toEqual({});
    expect(validateValues(schema, { name: 'Ann', level: 'blue', points: 1.5 })).toEqual({
      points: 'Must be a whole number.',
    });
  });
});

describe('SchemaForm', () => {
  it('renders groups, help text and required marks', () => {
    render(<Harness />);
    expect(screen.getByRole('region', { name: 'Member' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Extra' })).toBeInTheDocument();
    // The * sits right after the label text.
    expect(screen.getByText('Full name').parentElement?.textContent).toMatch(/^Full name\s*\*/);
    expect(screen.getByLabelText(/Full name/)).toBeInTheDocument();
    expect(screen.getByText('As printed.')).toBeInTheDocument();
  });

  it('sections groups as cards on a page and as headings inside a card', () => {
    const { unmount } = render(<Harness />);
    // A card's header (h2), distinct from the 14/500 field labels.
    expect(screen.getByRole('heading', { name: 'Member' }).tagName).toBe('H2');
    unmount();
    render(
      <Card>
        <Harness />
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Member' }).tagName).toBe('H3');
  });

  it('edits text, number and boolean values and drops emptied ones', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await user.type(screen.getByLabelText(/Full name/), 'Ann');
    expect(onValue).toHaveBeenLastCalledWith({ name: 'Ann' });
    await user.type(screen.getByLabelText('Points'), '7');
    expect(onValue).toHaveBeenLastCalledWith({ name: 'Ann', points: 7 });
    await user.click(screen.getByRole('switch', { name: /Active/ }));
    expect(onValue).toHaveBeenLastCalledWith({ name: 'Ann', points: 7, active: true });
    await user.clear(screen.getByLabelText('Points'));
    expect(onValue).toHaveBeenLastCalledWith({ name: 'Ann', active: true });
  });

  it('selects an enum option by its label', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await user.click(screen.getByRole('combobox', { name: /Level/ }));
    await user.click(await screen.findByRole('option', { name: 'Blue club' }));
    expect(onValue).toHaveBeenLastCalledWith({ level: 'blue' });
  });

  it('shows an error after blur, not while pristine', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByText('Required.')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Full name/));
    await user.tab();
    expect(await screen.findByText('Required.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Full name/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows all errors on demand and server errors always', () => {
    render(<Harness showAllErrors serverErrors={{ email: 'Already used.' }} />);
    expect(screen.getAllByText('Required.')).toHaveLength(2);
    expect(screen.getByText('Already used.')).toBeInTheDocument();
  });

  it('locks connection-owned fields with a From chip and resets a manual one', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(
      <Harness
        initial={{ name: 'Ann' }}
        fieldSources={{ name: 'manual', level: 'connection' }}
        sourceName="MemberSpot sync"
        onResetField={onReset}
      />,
    );
    expect(screen.getAllByText(/From MemberSpot sync/)).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: /Level/ })).toBeDisabled();
    await user.click(
      screen.getByRole('button', { name: "Use the connection's value for Full name" }),
    );
    expect(onReset).toHaveBeenCalledWith('name');
  });

  it('shows no chips without a connection', () => {
    render(<Harness initial={{ name: 'Ann' }} />);
    expect(screen.queryByText(/^From /)).toBeNull();
  });

  it('rejects an unsupported image file', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<Harness />);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'a.txt', { type: 'text/plain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported type');
  });

  it('stores an uploaded image as a data URI', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'a.png', { type: 'image/png' }));
    await vi.waitFor(() =>
      expect(onValue).toHaveBeenLastCalledWith({ photo: expect.stringMatching(/^data:/) }),
    );
  });

  describe('optional date-time', () => {
    const expiry = (extra: Record<string, unknown> = {}, required = false) => ({
      type: 'object',
      required: required ? ['expirationDate'] : [],
      properties: {
        expirationDate: { type: 'string', format: 'date-time', 'x-label': 'Expires', ...extra },
      },
    });

    it('starts checked with the date hidden, labelled from x-noneLabel', () => {
      render(<Harness schema={expiry({ 'x-noneLabel': 'Never expires' })} />);
      expect(screen.getByRole('checkbox', { name: 'Never expires' })).toBeChecked();
      expect(screen.queryByLabelText('Expires')).toBeNull();
    });

    it('defaults the label to No date', () => {
      render(<Harness schema={expiry()} />);
      expect(screen.getByRole('checkbox', { name: 'No date' })).toBeChecked();
    });

    it('checking it removes the value; unchecking shows the input', async () => {
      const user = userEvent.setup();
      const onValue = vi.fn();
      render(
        <Harness
          schema={expiry({ 'x-noneLabel': 'Never expires' })}
          initial={{ expirationDate: '2030-01-01T00:00:00Z' }}
          onValue={onValue}
        />,
      );
      const box = screen.getByRole('checkbox', { name: 'Never expires' });
      expect(box).not.toBeChecked();
      expect(screen.getByLabelText('Expires')).toBeEnabled();
      await user.click(box);
      expect(onValue).toHaveBeenLastCalledWith({});
      expect(screen.queryByLabelText('Expires')).toBeNull();
      await user.click(box);
      expect(screen.getByLabelText('Expires')).toBeEnabled();
    });

    it('has no checkbox when the field is required', () => {
      render(<Harness schema={expiry({}, true)} />);
      expect(screen.queryByRole('checkbox')).toBeNull();
    });
  });

  it('has no axe violations', async () => {
    const { container } = render(<Harness />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
