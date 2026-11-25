import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '../../../ui/index.ts';
import { DesignerProvider } from './context.tsx';
import { sampleDoc } from './fixtures.ts';
import { designerReducer, initialState } from './reducer.ts';
import { StyleSection } from './section-style.tsx';

function Harness() {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => initialState(sampleDoc()));
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
        <StyleSection />
      </TooltipProvider>
    </DesignerProvider>
  );
}

describe('Style section', () => {
  it('shows the Poster layout switch on Generic, then the layout toggle', async () => {
    render(<Harness />);
    expect(screen.queryByRole('radiogroup', { name: 'Edit layout' })).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Poster layout' }));
    expect(screen.getByRole('switch', { name: 'Poster layout' })).toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'Edit layout' })).toBeVisible();
  });
});
