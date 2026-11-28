import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CodeField } from './code-field.tsx';
import { HostedCard, lockoutLine } from './hosted-card.tsx';

const NOW = Date.UTC(2030, 0, 1, 20, 0, 0);

describe('lockoutLine', () => {
  it('counts down as m:ss under an hour', () => {
    expect(lockoutLine(NOW + 272_000, NOW)).toBe('Try again in 4:32.');
    expect(lockoutLine(NOW + 5_000, NOW)).toBe('Try again in 0:05.');
  });
  it('names the time in the org zone for longer locks', () => {
    const until = NOW + 2 * 3_600_000;
    expect(lockoutLine(until, NOW, 'America/Los_Angeles')).toBe('Try again at 2:00 PM.');
    expect(lockoutLine(until, NOW, 'Europe/Paris')).toBe('Try again at 11:00 PM.');
  });
});

function Field({ locked }: { locked?: { until: number; now: number } }) {
  const [v, setV] = useState('');
  return (
    <HostedCard title="Enter the code" size="hosted" lock={locked} line="Sent to you.">
      <CodeField id="c" value={v} onChange={setV} />
    </HostedCard>
  );
}

describe('HostedCard', () => {
  it('renders one h1 at hosted and stage, h2 at sheet and dialog', () => {
    const { rerender } = render(<HostedCard title="Sign in" size="stage" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    rerender(<HostedCard title="Sign in" size="sheet" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Sign in' })).toBeInTheDocument();
  });
  it('an error replaces the line in place', () => {
    const { rerender } = render(<HostedCard title="T" line="Sent to you." />);
    expect(screen.getByText('Sent to you.')).toBeInTheDocument();
    rerender(<HostedCard title="T" line="Sent to you." error="Wrong code." />);
    expect(screen.queryByText('Sent to you.')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong code.');
  });
  it('lockout disables the field and says when to retry', () => {
    render(<Field locked={{ until: NOW + 272_000, now: NOW }} />);
    expect(screen.getByRole('heading', { name: 'Too many tries' })).toBeInTheDocument();
    expect(screen.getByText('Try again in 4:32.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
  it('an expired lock leaves the field enabled', () => {
    render(<Field locked={{ until: NOW - 1, now: NOW }} />);
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Enter the code' })).toBeInTheDocument();
  });
  it('paste of a full code fills the field', async () => {
    render(<Field />);
    await userEvent.click(screen.getByRole('textbox'));
    await userEvent.paste('123 456');
    expect(screen.getByRole('textbox')).toHaveValue('123456');
  });
});
