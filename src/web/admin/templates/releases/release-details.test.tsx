import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChangeList } from './release-details.tsx';

describe('release changes', () => {
  it('shows one side of an added or removed line and dates in words', () => {
    render(
      <ChangeList
        changes={[
          { label: 'Paid through', kind: 'added', from: null, to: '2030-01-01T00:00:00Z' },
          { label: 'Message', kind: 'removed', from: 'Hello', to: null },
          { label: 'Background', kind: 'changed', from: 'red', to: 'blue' },
        ]}
      />,
    );
    expect(screen.getByText(/Jan 1, 2030/)).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('red → blue')).toBeInTheDocument();
    expect(screen.queryByText(/—/)).toBeNull();
    expect(screen.queryByText(/2030-01-01T/)).toBeNull();
  });
});
