import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LockScreenNotice } from './lock-screen.tsx';

const org = { id: 'o1', name: 'Northwind' };

describe('lock screen preview', () => {
  it('keeps the silent state at full opacity so its muted text stays readable', () => {
    render(<LockScreenNotice org={org} text="" silent />);
    const note = screen.getByText('No notification. The pass updates quietly.');
    expect(note.closest('[data-silent]')?.className).not.toMatch(/opacity/);
  });
});
