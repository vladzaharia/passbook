import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../lib/test-utils.tsx';
import { TooltipProvider } from '../../../ui/index.ts';
import { isoToLocal, localToIso, localToOffsetIso } from './datetime.ts';
import { defaultValues, type FormValues, keysBoundTo } from './schema.ts';
import { SchemaForm } from './schema-form.tsx';

describe('datetime conversion', () => {
  it('reads wall time in the given zone, not as UTC', () => {
    expect(localToIso('2027-01-31T23:59', 'America/Los_Angeles')).toBe('2027-02-01T07:59:00.000Z');
    expect(localToIso('2027-07-01T19:00', 'America/New_York')).toBe('2027-07-01T23:00:00.000Z');
    expect(localToIso('2027-01-31T23:59', 'UTC')).toBe('2027-01-31T23:59:00.000Z');
    expect(localToIso('2027-03-14T02:30', 'Asia/Kolkata')).toBe('2027-03-13T21:00:00.000Z');
  });

  it('shows a stored instant in the zone, honouring offsets', () => {
    expect(isoToLocal('2027-02-01T07:59:00.000Z', 'America/Los_Angeles')).toBe('2027-01-31T23:59');
    expect(isoToLocal('2027-01-31T23:59:00-08:00', 'America/Los_Angeles')).toBe('2027-01-31T23:59');
    expect(isoToLocal('nope', 'UTC')).toBe('');
  });

  it('writes the zone offset for local times', () => {
    expect(localToOffsetIso('2030-06-01T08:00', 'America/Los_Angeles')).toBe(
      '2030-06-01T08:00:00-07:00',
    );
    expect(localToOffsetIso('2027-03-14T02:30', 'Asia/Kolkata')).toBe('2027-03-14T02:30:00+05:30');
  });

  it('round-trips across a DST change', () => {
    const iso = localToIso('2027-11-07T01:30', 'America/Los_Angeles');
    expect(iso).toBeTruthy();
    expect(isoToLocal(iso as string, 'America/Los_Angeles')).toBe('2027-11-07T01:30');
  });
});

const schema = {
  type: 'object',
  properties: {
    expires: { type: 'string', format: 'date-time', 'x-label': 'Expires' },
    tier: { type: 'string', enum: ['a', 'b'], default: 'a', 'x-label': 'Tier' },
    plain: { type: 'string', enum: ['x', 'y'], 'x-label': 'Plain' },
    voided: { type: 'boolean', 'x-label': 'Void pass' },
  },
};

function Harness({
  onValue,
  initial = {},
}: {
  onValue: (v: FormValues) => void;
  initial?: FormValues;
}) {
  const [value, setValue] = useState<FormValues>(initial);
  return (
    <TooltipProvider>
      <SchemaForm
        schema={schema}
        value={value}
        hiddenKeys={new Set(['voided'])}
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
    </TooltipProvider>
  );
}

describe('SchemaForm datetime widget', () => {
  beforeEach(() => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['America/Los_Angeles', 'Asia/Kolkata']);
  });

  it('saves the local time with the zone offset, so the pass reads in local time', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await user.click(screen.getByRole('checkbox', { name: 'No date' }));
    await user.click(screen.getByRole('combobox', { name: /^Time zone/ }));
    await user.click(await screen.findByRole('option', { name: /Los Angeles/ }));
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '2027-01-31T23:59' } });
    expect(onValue).toHaveBeenLastCalledWith({ expires: '2027-01-31T23:59:00-08:00' });
    expect(screen.getByText(/Jan 31, 2027, 11:59 PM, Los Angeles/)).toBeInTheDocument();
  });

  it('shows a stored value in the zone its offset was written in', () => {
    render(<Harness onValue={vi.fn()} initial={{ expires: '2027-01-31T23:59:00-08:00' }} />);
    expect(screen.getByLabelText('Expires')).toHaveValue('2027-01-31T23:59');
  });

  it('hides the date and zone while No date is checked', async () => {
    const user = userEvent.setup();
    render(<Harness onValue={vi.fn()} initial={{ expires: '2027-01-31T23:59:00-08:00' }} />);
    await user.click(screen.getByRole('checkbox', { name: 'No date' }));
    expect(screen.queryByLabelText('Expires')).toBeNull();
    expect(screen.queryByRole('combobox', { name: /^Time zone/ })).toBeNull();
  });

  it('hides managed fields and offers no None for fields with a default', () => {
    render(<Harness onValue={vi.fn()} initial={defaultValues(schema)} />);
    expect(screen.queryByText('Void pass')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Tier' })).toHaveTextContent('a');
    expect(screen.getByRole('combobox', { name: 'Plain' })).toHaveTextContent('None');
  });
});

describe('schema helpers', () => {
  it('collects defaults', () => {
    expect(defaultValues(schema)).toEqual({ tier: 'a' });
  });
  it('finds keys bound to a pointer', () => {
    const manifest = {
      bindings: [
        { to: { pointer: '/voided' }, value: '{{voided}}' },
        { to: { pointer: '/expirationDate' }, value: '{{expires}}' },
        { to: { pointer: '/voided' }, value: 'x {{a}}' },
      ],
    };
    expect([...keysBoundTo(manifest, '/voided')]).toEqual(['voided']);
    expect(keysBoundTo(null, '/voided').size).toBe(0);
  });
});
