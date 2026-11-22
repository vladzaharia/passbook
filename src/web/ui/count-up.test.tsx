import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CountUp } from './count-up.tsx';

describe('CountUp', () => {
  it('shows a negative count as 0, never a minus', () => {
    render(<CountUp value={-16} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
  it('shows a plain count as it is', () => {
    render(<CountUp value={15} />);
    expect(screen.getByText('15')).toBeInTheDocument();
  });
});
