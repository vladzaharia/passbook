import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { TooltipProvider } from '../../../ui/index.ts';
import { renderTags } from '../../tags/test-fixtures.tsx';
import { DesignerProvider } from './context.tsx';
import { sampleDoc } from './fixtures.ts';
import { designerReducer, initialState } from './reducer.ts';
import { ColorsSection } from './section-colors.tsx';
import { ImagesSection } from './section-images.tsx';

afterEach(() => vi.restoreAllMocks());

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
        orgId: 'o1',
        stamps: { count: 0, setCount: () => {} },
      }}
    >
      <TooltipProvider>
        <ImagesSection />
        <ColorsSection />
      </TooltipProvider>
    </DesignerProvider>
  );
}

const show = (setup: PassSetup) =>
  renderTags(<Harness />, { '/api/v1/orgs/o1/pass-setup': () => json(setup) });

describe('Designer brand rows', () => {
  it('tags the organization logo, icon and colours From organization and locks their edit', async () => {
    show(viewOf(readyFacts()));
    const logo = (await screen.findByRole('button', { name: 'Replace Logo' })).closest('li');
    expect(logo).toHaveTextContent('From organization');
    expect(screen.getByRole('button', { name: 'Replace Logo' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'Background' })).toBeNull();
    expect(screen.getByText('Passes use the organization colours.')).toBeInTheDocument();
  });

  it('keeps the template own logo only after Override for this template, and writes the block', async () => {
    show(viewOf(readyFacts()));
    const logo = (await screen.findByRole('button', { name: 'Replace Logo' })).closest(
      'li',
    ) as HTMLElement;
    await userEvent.click(within(logo).getByRole('button', { name: 'Override for this template' }));
    expect(latest.manifest.brand).toEqual({ logo: 'template' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Logo' })).toBeEnabled());
    expect(logo).toHaveTextContent('This template');
    await userEvent.click(within(logo).getByRole('button', { name: 'Use organization' }));
    expect('brand' in latest.manifest).toBe(false);
  });

  it('overrides and restores the colours', async () => {
    show(viewOf(readyFacts()));
    await screen.findByText('Passes use the organization colours.');
    // Logo and icon come first; the colours' button is the last.
    const overrides = screen.getAllByRole('button', { name: 'Override for this template' });
    await userEvent.click(overrides[overrides.length - 1] as HTMLElement);
    expect(latest.manifest.brand).toMatchObject({ colors: 'template' });
    expect(await screen.findByRole('textbox', { name: 'Background' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Use organization' }));
    expect('brand' in latest.manifest).toBe(false);
  });

  it('shows the plain editors when the organization sets nothing', async () => {
    show(viewOf(newOrgFacts()));
    expect(await screen.findByRole('textbox', { name: 'Background' })).toBeVisible();
    expect(screen.queryByText('From organization')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Override for this template' })).toBeNull();
  });
});
