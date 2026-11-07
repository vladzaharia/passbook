import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import '../../../../lib/test-utils.tsx';
import { DesignerProvider } from '../context.tsx';
import { sampleDoc } from '../fixtures.ts';
import { initialState } from '../reducer.ts';
import { LookupSettings } from './lookup-settings.tsx';

it('selects and clears a lookup identifier through the template history', async () => {
  const user = userEvent.setup();
  const doc = sampleDoc();
  const edit = vi.fn();
  const value = {
    doc,
    state: initialState(doc),
    edit,
    select: vi.fn(),
    focusTarget: vi.fn(),
    dispatch: vi.fn(),
    assetBase: '',
    readOnly: false,
  };
  const { rerender } = render(
    <DesignerProvider value={value}>
      <LookupSettings />
    </DesignerProvider>,
  );
  await user.click(screen.getByRole('combobox', { name: 'Lookup ID' }));
  await user.click(screen.getByRole('option', { name: 'Name' }));
  expect(edit).toHaveBeenCalledWith({ op: 'scan-lookup', input: 'name' });
  doc.manifest.scan = { lookup: { input: 'name' } };
  rerender(
    <DesignerProvider value={value}>
      <LookupSettings />
    </DesignerProvider>,
  );
  await user.click(screen.getByRole('combobox', { name: 'Lookup ID' }));
  await user.click(screen.getByRole('option', { name: 'None' }));
  expect(edit).toHaveBeenLastCalledWith({ op: 'scan-lookup', input: '' });
});
