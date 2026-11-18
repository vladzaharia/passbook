import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import '../../../../../lib/test-utils.tsx';
import { TooltipProvider } from '../../../../../ui/index.ts';
import { applyOp, type Op } from '../../apply.ts';
import { DesignerProvider } from '../../context.tsx';
import type { DesignDoc } from '../../model.ts';
import { designerReducer, initialState } from '../../reducer.ts';
import { ActionsSection } from './actions-section.tsx';
import { readActions } from './model.ts';
import { docWithInputs } from './test-fixtures.ts';

function Harness({ doc, open }: { doc: DesignDoc; open?: string }) {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => {
    const s = initialState(doc);
    return open ? { ...s, select: { section: 'scan-actions' as const, key: open } } : s;
  });
  return (
    <DesignerProvider
      value={{
        state,
        doc: state.doc,
        edit: (op) => dispatch({ type: 'edit', op }),
        select: (select) => dispatch({ type: 'select', select }),
        focusTarget: () => {},
        dispatch,
        assetBase: '/assets',
        readOnly: false,
        stamps: { count: 4, setCount: () => {} },
      }}
    >
      <TooltipProvider>
        <ActionsSection />
        <output data-testid="doc">{JSON.stringify(readActions(state.doc))}</output>
      </TooltipProvider>
    </DesignerProvider>
  );
}

const scanDoc = (...ops: Op[]) =>
  ops.reduce(applyOp, applyOp(docWithInputs(), { op: 'scan-enable' }));
const actions = () =>
  JSON.parse(screen.getByTestId('doc').textContent ?? '[]') as Record<string, unknown>[];

describe('actions section', () => {
  it('starts scanning from a template without a scan block', async () => {
    const user = userEvent.setup();
    render(<Harness doc={docWithInputs()} />);
    await user.click(screen.getByRole('button', { name: 'Add scan actions' }));
    expect(screen.getByRole('list', { name: 'Actions' })).toBeInTheDocument();
    expect(actions()).toEqual([{ id: 'check_in', label: 'Check in', kind: 'check_in' }]);
  });

  it('adds an action of each kind from the buttons', async () => {
    const user = userEvent.setup();
    render(<Harness doc={scanDoc()} />);
    const add = screen.getByRole('group', { name: 'Add an action' });
    for (const name of ['Add', 'Take', 'Set', 'Use up'])
      await user.click(within(add).getByRole('button', { name }));
    expect(actions().map((a) => a.kind)).toEqual(['check_in', 'add', 'take', 'set', 'use_up']);
  });

  it('edits an add action: staff-entered amount with presets', async () => {
    const user = userEvent.setup();
    render(<Harness doc={scanDoc({ op: 'scan-action-add', kind: 'add' })} open="add" />);
    await user.click(screen.getByRole('radio', { name: 'Staff enter' }));
    expect(actions()[1]?.amount).toEqual({ max: 10 });
    const quick = screen.getByRole('textbox', { name: 'Quick amounts' });
    await user.type(quick, '5, 10, 20{Enter}');
    expect(actions()[1]?.amount).toEqual({ max: 10, presets: [5, 10, 20] });
    await user.click(screen.getByRole('radio', { name: 'Desk' }));
    await user.click(screen.getByRole('radio', { name: 'Manager' }));
    expect(actions()[1]?.minRole).toBe('manager');
  });

  it('shows engine issues inline, on the row and in the editor', async () => {
    const doc = scanDoc(
      { op: 'scan-action-add', kind: 'take' },
      { op: 'scan-action-set', id: 'take', patch: { input: 'tier' } },
    );
    render(<Harness doc={doc} open="take" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Input "tier" is not a number.');
    expect(screen.getByText('1 issue')).toBeInTheDocument();
  });

  it('shows a field error at its field', () => {
    const doc = scanDoc(
      { op: 'scan-action-add', kind: 'take' },
      { op: 'scan-action-set', id: 'take', patch: { amount: 5000 } },
    );
    render(<Harness doc={doc} open="take" />);
    expect(screen.getByText(/amount must be 1 to/)).toBeInTheDocument();
  });

  it('shows a warning as status', () => {
    const doc = scanDoc(
      { op: 'scan-action-add', kind: 'add' },
      { op: 'scan-action-set', id: 'add', patch: { notify: true } },
    );
    render(<Harness doc={doc} open="add" />);
    expect(
      screen
        .getAllByRole('status')
        .map((n) => n.textContent)
        .join(' '),
    ).toMatch(/daily push budget/);
  });

  it('sets a fixed value from a choice input', async () => {
    const user = userEvent.setup();
    const doc = scanDoc(
      { op: 'scan-action-add', kind: 'set' },
      { op: 'scan-action-set', id: 'set', patch: { input: 'tier' } },
    );
    render(<Harness doc={doc} open="set" />);
    await user.click(screen.getByRole('combobox', { name: 'Value' }));
    await user.click(screen.getByRole('option', { name: 'Option 2' }));
    expect(actions()[1]?.value).toBe('option_2');
  });

  it('edits the window and notes', async () => {
    const user = userEvent.setup();
    render(<Harness doc={scanDoc()} />);
    await user.click(screen.getByRole('combobox', { name: 'Valid from' }));
    await user.click(screen.getByRole('option', { name: 'Starts' }));
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByRole('list', { name: 'Notes' })).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Stop the scan' }));
    expect(screen.getByRole('switch', { name: 'Stop the scan' })).toBeChecked();
  });

  it('removes with undo available and never the last action', async () => {
    const user = userEvent.setup();
    render(<Harness doc={scanDoc({ op: 'scan-action-add', kind: 'add' })} />);
    await user.click(screen.getByRole('button', { name: 'Remove Add' }));
    expect(actions()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove Check in' })).toBeDisabled();
  });

  it('has no axe violations with every kind open', async () => {
    const doc = scanDoc(
      { op: 'scan-action-add', kind: 'add' },
      { op: 'scan-action-add', kind: 'take' },
      { op: 'scan-action-add', kind: 'set' },
      { op: 'scan-action-add', kind: 'use_up' },
      { op: 'scan-flags', flags: [{ input: 'tier', label: 'VIP', stop: true }] },
    );
    for (const open of ['check_in', 'add', 'take', 'set', 'use_up']) {
      const { container, unmount } = render(<Harness doc={doc} open={open} />);
      expect((await axe(container)).violations).toEqual([]);
      unmount();
    }
  });
});
