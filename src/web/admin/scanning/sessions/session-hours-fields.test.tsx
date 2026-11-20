import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { emptySessionDraft, type SessionDraft } from './draft.ts';
import { SessionHoursFields } from './session-hours-fields.tsx';

function Harness() {
  const [draft, setDraft] = useState<SessionDraft>({
    ...emptySessionDraft(),
    timeZone: 'Europe/London',
  });
  return (
    <SessionHoursFields draft={draft} set={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
  );
}

describe('session hours fields', () => {
  it('shows the week and its zone only while the switch is on', async () => {
    render(<Harness />);
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Open at set hours' }));
    expect(screen.getByRole('table', { name: 'Session hours' })).toBeTruthy();
    expect(screen.getByText(/Times are in London/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Monday, 9 AM to 5 PM, edit/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Open at set hours' }));
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('closed dates', () => {
  it('adds a closed date and special hours, and removes one', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('switch', { name: 'Open at set hours' }));
    const add = screen.getByRole('button', { name: 'Add' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Date'), '2026-12-25');
    await userEvent.click(add);
    expect(screen.getByText(/Fri, Dec 25, 2026/)).toBeTruthy();
    expect(screen.getByText(/· Closed/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Date'), '2026-12-31');
    await userEvent.type(screen.getByLabelText('Open from'), '1000');
    expect(screen.getByText('Set both times, or neither.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('To'), '1400');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/10 AM – 2 PM/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Fri, Dec 25, 2026' }));
    expect(screen.queryByText(/Fri, Dec 25, 2026/)).toBeNull();
  });
});
