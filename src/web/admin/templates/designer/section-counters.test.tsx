import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { TooltipProvider } from '../../../ui/index.ts';
import { DesignerProvider } from './context.tsx';
import { readCounters } from './counters.ts';
import { sampleDoc } from './fixtures.ts';
import { designerReducer, initialState } from './reducer.ts';
import { CountersSection } from './section-counters.tsx';

let latest = sampleDoc();
function Harness() {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => initialState(sampleDoc()));
  latest = state.doc;
  return (
    <DesignerProvider
      value={{
        state,
        doc: state.doc,
        edit: (op) => dispatch({ type: 'edit', op }),
        select: () => {},
        focusTarget: () => {},
        dispatch,
        assetBase: '/assets',
        readOnly: false,
        stamps: { count: 0, setCount: () => {} },
      }}
    >
      <TooltipProvider>
        <CountersSection />
      </TooltipProvider>
    </DesignerProvider>
  );
}

describe('Counters section', () => {
  it('defines a counter, sets its goal and turns on Use one and Refill', async () => {
    const { container } = render(<Harness />);
    expect(screen.getByText('Count what is left: visits, uses, credits.')).toBeVisible();
    await userEvent.type(screen.getByRole('textbox', { name: 'New counter' }), 'Visits');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Full: 10 left')).toBeVisible();
    const goal = screen.getByRole('spinbutton', { name: 'Goal' });
    await userEvent.clear(goal);
    await userEvent.type(goal, '8');
    expect(screen.getByText('Full: 8 left')).toBeVisible();
    await userEvent.click(screen.getByRole('switch', { name: 'Use one at the scanner' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Refill at the scanner' }));
    expect(screen.getByRole('switch', { name: 'Refill at the scanner' })).toBeChecked();
    expect((latest.manifest.scan as { actions: unknown[] }).actions).toHaveLength(2);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('removes a counter', async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole('textbox', { name: 'New counter' }), 'Visits');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Visits' }));
    expect(readCounters(latest)).toHaveLength(0);
  });
});
