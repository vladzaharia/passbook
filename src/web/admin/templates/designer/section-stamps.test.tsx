import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useReducer, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { TooltipProvider } from '../../../ui/index.ts';
import { applyOp } from './apply.ts';
import { DesignerProvider } from './context.tsx';
import { sampleDoc } from './fixtures.ts';
import type { DesignDoc } from './model.ts';
import { designerReducer, initialState } from './reducer.ts';
import { StampsSection } from './section-stamps.tsx';
import { ART_SLOTS, type ArtSlot, readStamps } from './stamps.ts';

vi.mock('./blueprint-art.ts', () => ({
  fetchBlueprintArt: async () =>
    Object.fromEntries(
      ART_SLOTS.map((s) => [
        s.slot,
        {
          name: s.file,
          slot: 'source',
          scale: 1,
          size: 4,
          upload: 'AAAA',
          width: 288,
          height: 288,
        },
      ]),
    ),
}));

const card = (): DesignDoc => {
  const doc = sampleDoc();
  doc.passJson.storeCard = doc.passJson.generic;
  delete doc.passJson.generic;
  return doc;
};
const art = Object.fromEntries(
  ART_SLOTS.map((s) => [
    s.slot,
    {
      name: s.file,
      slot: 'source',
      scale: 1 as const,
      size: 4,
      upload: 'AAAA',
      width: 288,
      height: 288,
    },
  ]),
) as Record<ArtSlot, never>;

function Harness({ doc, children }: { doc: DesignDoc; children?: ReactNode }) {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => initialState(doc));
  const [count, setCount] = useState(4);
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
        stamps: { count, setCount },
      }}
    >
      <TooltipProvider>
        <StampsSection />
        {children}
      </TooltipProvider>
    </DesignerProvider>
  );
}

describe('Stamps section', () => {
  it('offers one button without a block, and adds the block with the blueprint art', async () => {
    render(<Harness doc={card()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add stamps' }));
    expect(await screen.findByRole('button', { name: 'More stamps' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Stamp art' }).children).toHaveLength(4);
  });

  it('steps the goal from 3 to 20 and stops at both ends', async () => {
    render(<Harness doc={applyOp(card(), { op: 'stamps-add', art })} />);
    const less = screen.getByRole('button', { name: 'Fewer stamps' });
    const more = screen.getByRole('button', { name: 'More stamps' });
    await userEvent.click(less);
    expect(screen.getByRole('group', { name: 'Goal' })).toHaveTextContent('9');
    for (let i = 0; i < 6; i++) await userEvent.click(less);
    expect(screen.getByRole('group', { name: 'Goal' })).toHaveTextContent('3');
    expect(less).toBeDisabled();
    for (let i = 0; i < 17; i++) await userEvent.click(more);
    expect(screen.getByRole('group', { name: 'Goal' })).toHaveTextContent('20');
    expect(more).toBeDisabled();
  });

  it('explains the layout and the capacity for the goal', async () => {
    render(<Harness doc={applyOp(card(), { op: 'stamps-add', art })} />);
    expect(screen.getByText('2 rows of 5, 44 pt stamps')).toBeVisible();
    expect(screen.getByText(/Holds up to 19: a full card plus 9 saved/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Fewer stamps' }));
    expect(screen.getByText(/Holds up to 17/)).toBeVisible();
  });

  it('previews counts from 0 to the goal', async () => {
    render(<Harness doc={applyOp(card(), { op: 'stamps-add', art })} />);
    const slider = screen.getByRole('slider', { name: /Preview/ });
    expect(slider).toHaveAttribute('max', '10');
    expect(slider).toHaveValue('4');
    expect(screen.getByText('4 of 10')).toBeVisible();
  });

  it('marks reward art optional and lets it be removed', async () => {
    render(<Harness doc={applyOp(card(), { op: 'stamps-add', art })} />);
    expect(screen.getAllByText('Optional')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Remove reward' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove reward' })).toBeNull());
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<Harness doc={applyOp(card(), { op: 'stamps-add', art })} />);
    expect((await axe(container)).violations).toEqual([]);
    expect(readStamps(applyOp(card(), { op: 'stamps-add', art }))?.goal).toBe(10);
  });
});
