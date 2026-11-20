import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PassNote } from '../../../../shared/contracts/scan-history.ts';
import { ApiError } from '../../../lib/errors.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { Notes } from './notes.tsx';

const note = (id: string, body = 'Waiver unsigned', by = 'Jonas W.'): PassNote => ({
  id,
  at: Date.UTC(2026, 10, 17, 12),
  body,
  by,
});
const apiOf = (over: Partial<ScanApi> = {}) =>
  ({
    notes: vi.fn(async (id: string) => ({ items: id === 'p1' ? [note('n1')] : [] })),
    addNote: vi.fn(async (_id: string, b: { body: string }) => note('n2', b.body, 'Theo B.')),
    ...over,
  }) as unknown as ScanApi;
const view = (api: ScanApi, over: { passId?: string; openSignal?: number } = {}) => (
  <Notes api={api} passId="p1" openSignal={0} onAdded={() => undefined} {...over} />
);
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('Note'), { target: { value } });

describe('staff notes on the record', () => {
  it('lists notes with author and day, as staff only', async () => {
    render(view(apiOf()));
    await screen.findByText('Waiver unsigned');
    expect(screen.getByText('Jonas W. · Nov 17')).toBeTruthy();
    expect(screen.getByText('Staff only')).toBeTruthy();
  });

  it('opens on the signal, saves one line and shows it first', async () => {
    const api = apiOf();
    const onAdded = vi.fn();
    const { rerender } = render(<Notes api={api} passId="p1" openSignal={0} onAdded={onAdded} />);
    await screen.findByText('Waiver unsigned');
    rerender(<Notes api={api} passId="p1" openSignal={1} onAdded={onAdded} />);
    const field = await screen.findByLabelText('Note');
    expect(document.activeElement).toBe(field);
    type('  Ask Maya about Chidi  ');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Ask Maya about Chidi');
    expect(api.addNote).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ body: 'Ask Maya about Chidi' }),
    );
    expect(onAdded).toHaveBeenCalled();
    expect(screen.queryByLabelText('Note')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('op-note-add'));
  });

  it('keeps the same key when a failed save is sent again, and a new one for new text', async () => {
    const addNote = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(note('n2', 'Hello'));
    render(view(apiOf({ addNote } as never)));
    fireEvent.click(await screen.findByTestId('op-note-add'));
    type('Hello');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Could not save the note.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(addNote).toHaveBeenCalledTimes(2));
    const keys = addNote.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it('says why a save was refused: full, or too fast', async () => {
    const full = new ApiError({ status: 409, code: 'NOTE_CAP' });
    const fast = new ApiError({ status: 429, code: 'RATE_LIMITED' });
    const addNote = vi.fn().mockRejectedValueOnce(full).mockRejectedValueOnce(fast);
    render(view(apiOf({ addNote } as never)));
    fireEvent.click(await screen.findByTestId('op-note-add'));
    type('One');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('This pass has all the notes it can hold.');
    type('Two');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Too many notes. Try again in a minute.');
  });

  it('takes one plain line of at most 280 characters', async () => {
    const api = apiOf();
    render(view(api));
    fireEvent.click(await screen.findByTestId('op-note-add'));
    expect((screen.getByLabelText('Note') as HTMLInputElement).maxLength).toBe(280);
    type('   ');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    type('bell\u0007');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.addNote).not.toHaveBeenCalled();
  });

  it('Esc closes the field, drops the draft and does not close the record', async () => {
    const api = apiOf();
    const outer = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the record's own key handler
      <div onKeyDown={outer}>{view(api)}</div>,
    );
    fireEvent.click(await screen.findByTestId('op-note-add'));
    type('half a thought');
    fireEvent.keyDown(screen.getByLabelText('Note'), { key: 'Escape' });
    expect(screen.queryByLabelText('Note')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('op-note-add'));
    expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('');
  });

  it('drops the notes and the draft the moment the person changes', async () => {
    const api = apiOf();
    const { rerender } = render(view(api));
    fireEvent.click(await screen.findByTestId('op-note-add'));
    type('draft');
    await act(async () => rerender(view(api, { passId: 'p2' })));
    expect(screen.queryByText('Waiver unsigned')).toBeNull();
    expect(screen.queryByLabelText('Note')).toBeNull();
  });

  it('says so when notes cannot load', async () => {
    render(view(apiOf({ notes: vi.fn().mockRejectedValue(new Error('x')) } as never)));
    await screen.findByText(/Notes unavailable/);
  });
});
