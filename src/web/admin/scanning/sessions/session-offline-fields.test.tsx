import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { emptySessionDraft, type SessionDraft, sessionBody } from './draft.ts';
import { SessionOfflineFields } from './session-offline-fields.tsx';

function Harness({ start = {} }: { start?: Partial<SessionDraft> }) {
  const [draft, setDraft] = useState<SessionDraft>({ ...emptySessionDraft(), ...start });
  return (
    <>
      <SessionOfflineFields draft={draft} set={(p) => setDraft((d) => ({ ...d, ...p }))} />
      <output data-testid="body">{JSON.stringify(sessionBody(draft).settings)}</output>
    </>
  );
}
const settings = () => JSON.parse(screen.getByTestId('body').textContent ?? '{}');

describe('When offline', () => {
  it('defaults to Stop and saves the choice with the legacy flag in step', async () => {
    render(<Harness />);
    expect(settings()).toMatchObject({ whenOffline: 'stop', offline: false });
    await userEvent.click(screen.getByRole('radio', { name: 'Use the offline list' }));
    expect(settings()).toMatchObject({ whenOffline: 'list', offline: true });
    await userEvent.click(screen.getByRole('radio', { name: 'Staff decide' }));
    expect(settings()).toMatchObject({ whenOffline: 'decide', offline: false });
  });

  it('offers the list only where it can work', () => {
    render(<Harness start={{ zoneIds: ['z1'] }} />);
    expect(
      (screen.getByRole('radio', { name: 'Use the offline list' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('note').textContent).toMatch(/zones/);
    expect((screen.getByRole('radio', { name: 'Staff decide' }) as HTMLInputElement).disabled).toBe(
      false,
    );
  });
});
