import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TechnicalDetails } from './key-value.tsx';
import { TooltipProvider } from './tooltip.tsx';

describe('TechnicalDetails', () => {
  it('shows each id with a Copy ID button, closed by default', () => {
    const { container } = render(
      <TooltipProvider>
        <TechnicalDetails items={[{ label: 'Serial number', value: '01a1f0e7-11ed-788a' }]} />
      </TooltipProvider>,
    );
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('01a1f0e7-11ed-788a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy ID', hidden: true })).toBeInTheDocument();
  });
});
