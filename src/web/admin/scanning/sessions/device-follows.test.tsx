import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { ScanDeviceOverrides, ScanningDevice } from '@/shared/contracts/scanning-sessions.ts';
import { DeviceFollows, followable } from './device-follows.tsx';

const device = (id: string, name: string, over: Partial<ScanningDevice> = {}) =>
  ({
    id,
    name,
    revoked: false,
    deviceRole: 'scan',
    effectiveSurface: 'phone',
    ...over,
  }) as ScanningDevice;
const doors = [
  device('a', 'North door'),
  device('b', 'South door'),
  device('c', 'Old door', { revoked: true }),
  device('d', 'Screen', { deviceRole: 'customer', surface: null, effectiveSurface: null }),
];

function Harness({ start = {} }: { start?: ScanDeviceOverrides }) {
  const [value, setValue] = useState<ScanDeviceOverrides>(start);
  return (
    <>
      <DeviceFollows value={value} onChange={setValue} scanners={followable(doors)} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}
const value = () => JSON.parse(screen.getByTestId('value').textContent ?? '{}');

describe('Scanners shown', () => {
  it('lists live scanners only, and defaults to all of them', () => {
    expect(followable(doors).map((d) => d.id)).toEqual(['a', 'b']);
    render(<Harness />);
    expect(value()).toEqual({});
    expect(screen.queryByRole('checkbox', { name: 'North door' })).toBeNull();
  });

  it('narrows to chosen scanners and returns to all', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('switch', { name: 'All scanners in this session' }));
    expect(value()).toEqual({ follows: ['a', 'b'] });
    await userEvent.click(screen.getByRole('checkbox', { name: 'South door' }));
    expect(value()).toEqual({ follows: ['a'] });
    expect(
      (screen.getByRole('checkbox', { name: 'North door' }) as HTMLInputElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole('switch', { name: 'All scanners in this session' }));
    expect(value()).toEqual({});
  });

  it('drops ids of revoked scanners on the next edit, and never widens to all', async () => {
    render(<Harness start={{ follows: ['a', 'gone'] }} />);
    expect(
      (screen.getByRole('checkbox', { name: 'North door' }) as HTMLInputElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'South door' }));
    expect(value()).toEqual({ follows: ['a', 'b'] });
  });
});
