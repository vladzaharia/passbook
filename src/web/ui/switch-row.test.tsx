import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../lib/test-utils.tsx';
import { SwitchRow } from './switch-row.tsx';

describe('SwitchRow', () => {
  it('labels the switch, describes it with the help and toggles', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const { container } = render(
      <SwitchRow
        label="Auto sync"
        help="Runs every hour."
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const sw = screen.getByRole('switch', { name: 'Auto sync' });
    expect(sw).toHaveAccessibleDescription('Runs every hour.');
    await user.click(screen.getByText('Auto sync'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect((await axe(container)).violations).toEqual([]);
  });
});
