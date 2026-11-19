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
