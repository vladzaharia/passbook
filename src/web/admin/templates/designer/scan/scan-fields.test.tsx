import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SCAN_ICONS } from '@/passkit/template/scan-display/icons.ts';
import '../../../../lib/test-utils.tsx';
import { ScanIconField, ScanRoleField } from './scan-fields.tsx';

describe('scan binding fields', () => {
  it('offers exactly the curated icons and the three audience roles', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(
      <>
        <ScanIconField value={undefined} onChange={changed} />
        <ScanRoleField value={undefined} onChange={changed} />
      </>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Icon' }));
    const icons = screen.getAllByRole('option');
    expect(icons).toHaveLength(SCAN_ICONS.length + 1);
    await user.click(screen.getByRole('option', { name: /^crown/i }));
    expect(changed).toHaveBeenLastCalledWith('crown');
    await user.click(screen.getByRole('radio', { name: 'Desk and up' }));
    expect(changed).toHaveBeenLastCalledWith('desk');
  });
});
