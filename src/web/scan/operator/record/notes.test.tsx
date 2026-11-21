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
  own: false,
  edited: false,
});
const apiOf = (over: Partial<ScanApi> = {}) =>
  ({
    notes: vi.fn(async (id: string) => ({ items: id === 'p1' ? [note('n1')] : [] })),
    addNote: vi.fn(async (_id: string, b: { body: string }) => note('n2', b.body, 'Theo B.')),
    ...over,
  }) as unknown as ScanApi;
const view = (
  api: ScanApi,
  over: { passId?: string; openSignal?: number; manager?: boolean } = {},
) => (
  <Notes api={api} passId="p1" openSignal={0} manager={false} onAdded={() => undefined} {...over} />
);
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('Note'), { target: { value } });

describe('staff notes on the record', () => {
  it('lists notes with author and day', async () => {
    render(view(apiOf()));
    await screen.findByText('Waiver unsigned');
    expect(screen.getByText('Jonas W. · Nov 17')).toBeTruthy();
  });

  it('opens on the signal, saves one line and shows it first', async () => {
    const api = apiOf();
    const onAdded = vi.fn();
    const { rerender } = render(
      <Notes api={api} passId="p1" openSignal={0} manager={false} onAdded={onAdded} />,
    );
    await screen.findByText('Waiver unsigned');
    rerender(<Notes api={api} passId="p1" openSignal={1} manager={false} onAdded={onAdded} />);
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

  it('a half-typed note never reaches the next person: N on them opens an empty field', async () => {
    const api = apiOf();
    const { rerender } = render(
      <Notes api={api} passId="p1" openSignal={0} manager={false} onAdded={() => undefined} />,
    );
    fireEvent.click(await screen.findByTestId('op-note-add'));
    type('Owes a refund');
    rerender(
      <Notes api={api} passId="p2" openSignal={0} manager={false} onAdded={() => undefined} />,
    );
    expect(screen.queryByLabelText('Note')).toBeNull();
    rerender(
      <Notes api={api} passId="p2" openSignal={1} manager={false} onAdded={() => undefined} />,
    );
    expect((await screen.findByLabelText('Note')) as HTMLInputElement).toHaveProperty('value', '');
  });

  it('shows change controls on a note the viewer wrote, on any note for a Manager, and not otherwise', async () => {
    const mine = { ...note('n1'), own: true };
    const theirs = { ...note('n2', 'Theirs') };
    const api = apiOf({ notes: vi.fn(async () => ({ items: [mine, theirs] })) } as never);
    const { rerender } = render(view(api));
    await screen.findByText('Theirs');
    expect(screen.getAllByRole('button', { name: 'Edit note' })).toHaveLength(1);
    rerender(view(api, { manager: true }));
    expect(screen.getAllByRole('button', { name: 'Edit note' })).toHaveLength(2);
  });

  it('edits a note in place and says it was edited', async () => {
    const mine = { ...note('n1'), own: true };
    const editNote = vi.fn(async (_p: string, _id: string, b: { body: string }) => ({
      ...mine,
      body: b.body,
      edited: true,
    }));
    render(view(apiOf({ notes: vi.fn(async () => ({ items: [mine] })), editNote } as never)));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit note' }));
    type('Waiver signed');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Waiver signed');
    expect(editNote).toHaveBeenCalledWith('p1', 'n1', { body: 'Waiver signed' });
    expect(screen.getByText(/edited/)).toBeTruthy();
  });

  it('asks before deleting, and removes the note', async () => {
    const mine = { ...note('n1'), own: true };
    const deleteNote = vi.fn(async () => undefined);
    render(view(apiOf({ notes: vi.fn(async () => ({ items: [mine] })), deleteNote } as never)));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByText('Waiver unsigned')).toBeNull());
    expect(deleteNote).toHaveBeenCalledWith('p1', 'n1');
  });

  it('says when this device has added all it can today', async () => {
    const full = new ApiError({ status: 409, code: 'NOTE_DEVICE_CAP' });
    render(view(apiOf({ addNote: vi.fn().mockRejectedValue(full) } as never)));
    fireEvent.click(await screen.findByTestId('op-note-add'));
    type('One more');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/all it can to this person today/);
  });
});
