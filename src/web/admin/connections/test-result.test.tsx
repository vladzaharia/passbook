import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TestResult } from './test-result.tsx';

describe('TestResult', () => {
  it('stays a bare live region while idle, whatever width the caller asks for', () => {
    render(<TestResult className="max-lg:w-full lg:max-w-md" />);
    const live = screen.getByRole('status');
    expect(live).toHaveClass('sr-only');
    expect(live.className).not.toMatch(/max-lg:w-full|lg:max-w-md/);
  });
});
