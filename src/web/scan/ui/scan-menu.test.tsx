import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ScanMenu, type ScanMenuProps } from './scan-menu.tsx';
import { ScanShell } from './scan-shell.tsx';

function menu(over: Partial<ScanMenuProps> = {}) {
  const props: ScanMenuProps = {
    sound: true,
    onSound: vi.fn(),
    holdResults: false,
    onHoldResults: vi.fn(),
    camera: 'back',
    onCamera: vi.fn(),
    onShift: vi.fn(),
    onEndShift: vi.fn(),
    leave: 'unpair',
    onLeave: vi.fn(),
    open: true,
    ...over,
  };
  render(<ScanMenu {...props} />);
  return props;
}

const handheld = (over = {}) => ({
  sunlight: false,
  onSunlight: vi.fn(),
  leftHand: false,
  onLeftHand: vi.fn(),
  canBuzz: true,
  ...over,
});

describe('the handheld settings in the scanner menu', () => {
  it('are on a handheld only', () => {
    menu();
    expect(screen.queryByText('Sunlight mode')).toBeNull();
    expect(screen.queryByText('Left hand')).toBeNull();
  });

  it('switch sunlight mode and the left hand', async () => {
    const h = handheld();
    menu({ handheld: h });
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Sunlight mode' }));
    expect(h.onSunlight).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Left hand' }));
    expect(h.onLeftHand).toHaveBeenCalledWith(true);
  });

  it('show a switch that is on as checked', () => {
    menu({ handheld: handheld({ sunlight: true }) });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Sunlight mode' })).toBeChecked();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Left hand' })).not.toBeChecked();
  });

  it('say vibration needs the app where the device cannot buzz', () => {
    menu({ handheld: handheld({ canBuzz: false }) });
    expect(screen.getByText('Vibration needs the PassBook app.')).toBeInTheDocument();
  });

  it('say nothing about vibration where it works', () => {
    menu({ handheld: handheld() });
    expect(screen.queryByText(/Vibration needs/)).toBeNull();
  });
});

describe('the shell look', () => {
  it('marks sunlight mode and the left hand, and nothing otherwise', () => {
    const { rerender } = render(<ScanShell tint="red" look={{ sun: true, leftHand: true }} />);
    const shell = screen.getByRole('main', { name: 'Scanner' });
    expect(shell).toHaveAttribute('data-sun');
    expect(shell).toHaveAttribute('data-hand', 'left');
    expect(shell).toHaveAttribute('data-tint', 'red');
    rerender(<ScanShell tint="none" look={{ sun: false, leftHand: false }} />);
    expect(shell).not.toHaveAttribute('data-sun');
    expect(shell).not.toHaveAttribute('data-hand');
  });
});
