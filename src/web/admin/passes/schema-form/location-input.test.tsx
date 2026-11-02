import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LocationInput } from './location-input.tsx';
import type { FieldDef } from './schema.ts';

const field = (key: string, label: string): FieldDef => ({
  key,
  label,
  group: 'Location',
  order: 1,
  widget: 'number',
  type: 'number',
  required: false,
  hasDefault: false,
  noneLabel: '',
  schema: {},
});
const pair = {
  prefix: 'office',
  lat: field('officeLat', 'Office latitude'),
  lng: field('officeLng', 'Office longitude'),
};

describe('LocationInput', () => {
  it('fills both coordinates from typed text', async () => {
    const onChange = vi.fn();
    render(<LocationInput pair={pair} value={{}} onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), '47.6, -122.3');
    expect(onChange).toHaveBeenLastCalledWith({ officeLat: 47.6, officeLng: -122.3 });
  });

  it('fills both from a Maps link', async () => {
    const onChange = vi.fn();
    render(<LocationInput pair={pair} value={{}} onChange={onChange} />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.paste('https://maps.apple.com/?ll=10.5,20.25');
    expect(onChange).toHaveBeenLastCalledWith({ officeLat: 10.5, officeLng: 20.25 });
  });

  it('says what is wrong and does not write an out-of-range pair', async () => {
    const onChange = vi.fn();
    render(<LocationInput pair={pair} value={{}} onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), '95, 10');
    expect(screen.getByText('Latitude must be from -90 to 90.')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith({ officeLat: 95, officeLng: 10 });
  });

  it('clears both when emptied', async () => {
    const onChange = vi.fn();
    render(
      <LocationInput pair={pair} value={{ officeLat: 1, officeLng: 2 }} onChange={onChange} />,
    );
    await userEvent.clear(screen.getByRole('textbox'));
    expect(onChange).toHaveBeenLastCalledWith({ officeLat: undefined, officeLng: undefined });
  });

  it('shows the stored pair as text', () => {
    render(<LocationInput pair={pair} value={{ officeLat: 1, officeLng: 2 }} onChange={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('1, 2');
  });
});
