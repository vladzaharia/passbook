import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Combobox } from './combobox.tsx';

describe('Combobox', () => {
  it('shows the same down chevron as Select', () => {
    render(
      <Combobox
        aria-label="Action"
        options={[{ value: 'a', label: 'A' }]}
        value="a"
        onValueChange={() => {}}
      />,
    );
    const trigger = screen.getByRole('combobox');
    expect(trigger.querySelector('svg.lucide-chevron-down')).not.toBeNull();
    expect(trigger.querySelector('svg.lucide-chevrons-up-down')).toBeNull();
  });
});
