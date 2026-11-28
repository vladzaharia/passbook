import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModeSwitch } from './designer-modes.tsx';

const options = [
  { value: 'pass', label: 'Pass' },
  { value: 'scan', label: 'Scan screen' },
  { value: 'wallets', label: 'Wallets' },
] as const;

function width(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query.includes('639'),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('ModeSwitch', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is a select on a phone', () => {
    width(true);
    render(<ModeSwitch mode="pass" options={options} onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: /Designer mode/ })).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('is a segmented control from tablet up', () => {
    width(false);
    render(<ModeSwitch mode="pass" options={options} onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Designer mode' })).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
