import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import JsonRecords from './json-records.tsx';

const DOC = {
  meta: { total: 2 },
  members: [
    { number: 'A-1', email: 'maya@example.test' },
    { number: 'A-2', email: 'noor@example.test' },
  ],
};

function setup(records = '/members') {
  const onRecords = vi.fn();
  const onId = vi.fn();
  render(
    <JsonRecords
      doc={DOC}
      records={records}
      idColumn="/number"
      onRecords={onRecords}
      onId={onId}
    />,
  );
  return { onRecords, onId, user: userEvent.setup() };
}

describe('JsonRecords', () => {
  it('marks where the records and the ID are', () => {
    setup();
    const tree = screen.getByRole('tree', { name: 'JSON file' });
    expect(tree).toHaveTextContent('Records');
    expect(tree).toHaveTextContent('ID');
  });

  it('picks a value in a record as the ID, relative to the record', async () => {
    const { user, onId } = setup();
    await user.click(screen.getByText('"maya@example.test"'));
    await user.click(screen.getByRole('button', { name: 'Use as ID' }));
    expect(onId).toHaveBeenCalledWith('/email');
  });

  it('picks another list as the records', async () => {
    const { user, onRecords } = setup('/other');
    await user.click(screen.getByText('members'));
    await user.click(screen.getByRole('button', { name: 'Use as records' }));
    expect(onRecords).toHaveBeenCalledWith('/members');
  });

  it('offers nothing a file has no use for', async () => {
    const { user } = setup();
    await user.click(screen.getByText('"maya@example.test"'));
    expect(screen.queryByRole('button', { name: 'Use as updated time' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use as holder email' })).toBeNull();
  });
});
