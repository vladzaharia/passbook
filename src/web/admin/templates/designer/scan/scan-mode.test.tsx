import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_ACTION } from '@/shared/scan-defaults.ts';
import '../../../../lib/test-utils.tsx';
import { TooltipProvider } from '../../../../ui/index.ts';
import type { Op } from '../apply.ts';
import { DesignerProvider } from '../context.tsx';
import { sampleDoc } from '../fixtures.ts';
import type { Selection } from '../model.ts';
import { designerReducer, initialState, isDirty } from '../reducer.ts';
import { ScanMode } from './scan-mode.tsx';

function Harness() {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => {
    const doc = sampleDoc();
    doc.manifest.scan = {
      actions: [DEFAULT_SCAN_ACTION],
      display: {
        v: 1,
        header: {},
        panels: [
          {
            id: 'p_panel',
            title: 'Details',
            rows: [
              { id: 'r_first', type: 'field', label: 'First', value: 'One' },
              { id: 'r_second', type: 'field', label: 'Second', value: 'Two' },
            ],
          },
        ],
      },
    };
    return initialState(doc);
  });
  const select = (value: Selection) => dispatch({ type: 'select', select: value });
  const edit = (op: Op, merge?: string) =>
    dispatch({ type: 'edit', op, ...(merge ? { merge } : {}), at: 1 });
  return (
    <TooltipProvider>
      <DesignerProvider
        value={{
          state,
          doc: state.doc,
          edit,
          select,
          focusTarget: select,
          dispatch,
          assetBase: '',
          readOnly: false,
        }}
      >
        <ScanMode templateId="tpl1" orgId="org1" issues={<div>Issues</div>} />
        <p>{isDirty(state) ? 'Dirty' : 'Saved'}</p>
        <button type="button" onClick={() => dispatch({ type: 'undo' })}>
          Undo test edit
        </button>
      </DesignerProvider>
    </TooltipProvider>
  );
}

describe('scan mode shared history', () => {
  it('applies a keyboard canvas removal to the shared draft and can undo it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const preview = screen.getByRole('group', { name: /Scan screen preview/ });
    expect(within(preview).getByText('One')).toBeInTheDocument();
    fireEvent.keyDown(within(preview).getAllByRole('button', { name: 'Row field' })[0]!, {
      key: 'Delete',
    });
    expect(within(preview).queryByText('One')).not.toBeInTheDocument();
    expect(screen.getByText('Dirty')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo test edit' }));
    expect(within(preview).getByText('One')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('moves keyboard focus between a canvas row and its inspector', async () => {
    render(<Harness />);
    const preview = screen.getByRole('group', { name: /Scan screen preview/ });
    const row = within(preview).getAllByRole('button', { name: 'Row field' })[0]!;
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    const label = await screen.findByLabelText('Label');
    await waitFor(() => expect(label).toHaveFocus());
    fireEvent.keyDown(label, { key: 'Escape' });
    expect(row).toHaveFocus();
  });
});
