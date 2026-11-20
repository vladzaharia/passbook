import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { emptySessionDraft, type SessionDraft } from './draft.ts';
import { ClosedDates } from './session-closed-dates.tsx';
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
    await userEvent.type(screen.getByLabelText('Date'), '2099-12-25');
    await userEvent.click(add);
    expect(screen.getByText(/Dec 25, 2099/)).toBeTruthy();
    expect(screen.getByText(/· Closed/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Date'), '2099-12-31');
    await userEvent.type(screen.getByLabelText('Open from'), '1000');
    expect(screen.getByText('Set both times, or neither.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('To'), '1400');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/10 AM – 2 PM/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Remove .*Dec 25, 2099/ }));
    expect(screen.queryByText(/Dec 25, 2099/)).toBeNull();
  });

  it('hides dates already past in the session zone', async () => {
    render(
      <ClosedDates
        timeZone="Europe/London"
        dates={{ '2020-01-01': [], '2099-01-01': [] }}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByText(/Jan 1, 2020/)).toBeNull();
    expect(screen.getByText(/Jan 1, 2099/)).toBeTruthy();
  });

  it('updates a listed date, blocks past dates and stops at 60', async () => {
    const onChange = vi.fn();
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `2099-${String((i % 12) + 1).padStart(2, '0')}-${String(Math.floor(i / 12) + 1).padStart(2, '0')}`,
        [],
      ]),
    );
    render(<ClosedDates timeZone="UTC" dates={many} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Date'), '2099-01-01');
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Date'));
    await userEvent.type(screen.getByLabelText('Date'), '2099-06-30');
    expect(screen.getByText('At most 60 dates.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks a date before today', async () => {
    render(<ClosedDates timeZone="UTC" dates={{}} onChange={() => {}} />);
    await userEvent.type(screen.getByLabelText('Date'), '2020-01-01');
    expect(screen.getByText('Pick today or later.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
