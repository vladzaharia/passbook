import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DependentSettings } from './dependent-settings.tsx';

const field = () => <input aria-label="Daily limit" defaultValue="40" />;

describe('DependentSettings', () => {
  it('hides the children while the parent is off, inert and out of the tree', () => {
    const { container } = render(<DependentSettings open={false}>{field()}</DependentSettings>);
    expect(screen.queryByRole('textbox', { name: 'Daily limit' })).toBeNull();
    expect(container.querySelector('.wl-dependent')).not.toHaveAttribute('data-open');
    expect(container.querySelector('.wl-dependent')).toHaveAttribute('inert');
  });

  it('shows them when on', () => {
    render(<DependentSettings open>{field()}</DependentSettings>);
    expect(screen.getByRole('textbox', { name: 'Daily limit' })).toBeVisible();
  });

  it('keeps the value across off and on', () => {
    const { rerender } = render(<DependentSettings open>{field()}</DependentSettings>);
    rerender(<DependentSettings open={false}>{field()}</DependentSettings>);
    rerender(<DependentSettings open>{field()}</DependentSettings>);
    expect(screen.getByRole('textbox', { name: 'Daily limit' })).toHaveValue('40');
  });

  it('shows only the unsupported line, without the children', () => {
    render(
      <DependentSettings open unsupported="Needs a generated barcode.">
        {field()}
      </DependentSettings>,
    );
    expect(screen.getByText('Needs a generated barcode.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
