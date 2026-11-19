import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installDomShims } from '@/web/lib/test-utils.tsx';
import { SessionActivity } from './session-activity.tsx';

installDomShims();

const row = {
  id: 'a',
  at: Date.UTC(2026, 10, 1, 5),
  deviceId: 'd',
  deviceName: 'Door',
  passId: 'p',
  title: 'Member',
  outcome: 'ok' as const,
  direction: null,
};

describe('SessionActivity', () => {
  it('keeps the shared Done chip, names check-outs, and uses the session zone', () => {
    render(
      <SessionActivity
        timeZone="America/New_York"
        items={[
          { ...row, id: 'in' },
          { ...row, id: 'out', direction: 'out' },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { name: /New York time/ })).toBeInTheDocument();
    expect(screen.getAllByText('Done')).toHaveLength(2);
    expect(screen.getAllByText(/Door · 1:00\s?AM/)).toHaveLength(2);
    expect(screen.getByText(/· Check out/)).toBeInTheDocument();
  });
});
