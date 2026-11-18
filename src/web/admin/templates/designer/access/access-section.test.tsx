import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../../../lib/test-utils.tsx';
import { TooltipProvider } from '../../../../ui/index.ts';
import { applyOp } from '../apply.ts';
import { DesignerProvider } from '../context.tsx';
import { sampleDoc } from '../fixtures.ts';
import type { DesignDoc } from '../model.ts';
import { designerReducer, initialState } from '../reducer.ts';
import { AccessSection } from './access-section.tsx';
import { readAccess } from './model.ts';

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock('../../../scanning/zones-query.ts', () => ({
  useZones: () => ({
    isSuccess: true,
    isError: false,
    isPending: false,
    data: {
      items: [
        { id: 'z1', key: 'pool', name: 'Pool', depth: 0, effectiveTimeZone: 'America/Chicago' },
        { id: 'z2', key: 'studio', name: 'Studio', depth: 0, effectiveTimeZone: 'America/Chicago' },
      ],
    },
  }),
}));

function Harness({ doc, open }: { doc: DesignDoc; open?: string }) {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => {
    const s = initialState(doc);
    return open ? { ...s, select: { section: 'access' as const, key: open } } : s;
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
        <AccessSection />
        <output data-testid="doc">{JSON.stringify(readAccess(state.doc)?.plans ?? null)}</output>
      </TooltipProvider>
    </DesignerProvider>
  );
}

const timed = (): DesignDoc => {
  let doc = applyOp(sampleDoc(), { op: 'access-enable' });
  doc = applyOp(doc, { op: 'access-plan-kind', id: 'member', kind: 'timed' });
  return applyOp(doc, {
    op: 'access-plan-set',
    id: 'member',
    patch: {
      label: 'Off-peak',
      hours: { mon: ['06:00-16:00', '20:00-23:00'], sat: ['08:00-20:00'] },
    },
  });
};
const plans = () =>
  JSON.parse(screen.getByTestId('doc').textContent ?? 'null') as {
    hours?: Record<string, string[]>;
    zones: { zone: string; hours?: unknown }[];
    kind: string;
  }[];

describe('Access section', () => {
  it('starts as one switch and turns a template into an access card', async () => {
    const user = userEvent.setup();
    render(<Harness doc={sampleDoc()} />);
    expect(screen.getByTestId('doc')).toHaveTextContent('null');
    await user.click(screen.getByRole('switch', { name: 'Use as an access card' }));
    expect(plans()).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'Plans' })).toHaveTextContent('Member');
    expect(screen.getByRole('list', { name: 'Plans' })).toHaveTextContent('24/7');
    expect(screen.getByRole('list', { name: 'Plans' })).toHaveTextContent('Any time');
  });

  it('lists plans with type pill and summary, and adds one up to the limit', async () => {
    const user = userEvent.setup();
    render(<Harness doc={timed()} />);
    const list = screen.getByRole('list', { name: 'Plans' });
    expect(list).toHaveTextContent('Off-peak');
    expect(list).toHaveTextContent('Timed');
    expect(list).toHaveTextContent('Mon 6 AM–4 PM, 8 PM–11 PM · Sat 8 AM–8 PM');
    await user.click(screen.getByRole('button', { name: 'Add plan' }));
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThanOrEqual(2);
    expect(plans()).toHaveLength(2);
  });

  it('copies Monday to weekdays', async () => {
    const user = userEvent.setup();
    render(<Harness doc={timed()} open="member" />);
    await user.click(screen.getByRole('button', { name: 'Copy Monday to weekdays' }));
    const hours = plans()[0]?.hours ?? {};
    for (const day of ['tue', 'wed', 'thu', 'fri'])
      expect(hours[day]).toEqual(['06:00-16:00', '20:00-23:00']);
    expect(hours.sat).toEqual(['08:00-20:00']);
    expect(hours.sun).toBeUndefined();
  });

  it('closes a day and reopens it with working hours', async () => {
    const user = userEvent.setup();
    render(<Harness doc={timed()} open="member" />);
    await user.click(screen.getByRole('checkbox', { name: 'Saturday closed' }));
    expect(plans()[0]?.hours?.sat).toBeUndefined();
    await user.click(screen.getByRole('checkbox', { name: 'Saturday closed' }));
    expect(plans()[0]?.hours?.sat).toEqual(['09:00-17:00']);
  });

  it('works from the keyboard: add hours, type the times, see the overlap', async () => {
    const user = userEvent.setup();
    render(<Harness doc={timed()} open="member" />);
    const add = screen.getByRole('button', { name: 'Add hours on Tuesday' });
    add.focus();
    await user.keyboard('{Enter}');
    expect(plans()[0]?.hours?.tue).toEqual(['09:00-17:00']);
    const group = screen.getByRole('group', { name: 'Tuesday hours' });
    expect(within(group).getByLabelText('From')).toHaveValue('09:00');
    await user.click(add);
    expect(plans()[0]?.hours?.tue).toEqual(['09:00-17:00', '17:00-19:00']);
    const second = screen.getByRole('group', { name: 'Tuesday hours' });
    await user.clear(within(second).getByLabelText('From'));
    await user.type(within(second).getByLabelText('From'), '16:00');
    expect(plans()[0]?.hours?.tue).toEqual(['09:00-17:00', '16:00-19:00']);
    expect(within(second).getByRole('alert')).toHaveTextContent('Overlaps 9 AM – 5 PM.');
    await user.click(within(second).getByRole('button', { name: 'Done' }));
    expect(screen.getAllByRole('alert').some((a) => /overlap/i.test(a.textContent ?? ''))).toBe(
      true,
    );
    expect(screen.getByRole('list', { name: 'Plans' })).toHaveTextContent('1 issue');
    expect(screen.getByText('Off-peak: hours overlap on Tuesday.')).toBeInTheDocument();
  });

  it('opens a span with the keyboard and names it for assistive tech', async () => {
    const user = userEvent.setup();
    render(<Harness doc={timed()} open="member" />);
    const span = screen.getByRole('button', { name: 'Monday, 6 AM to 4 PM, edit' });
    span.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('group', { name: 'Monday hours' })).toBeInTheDocument();
    expect(span).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(plans()[0]?.hours?.mon).toEqual(['20:00-23:00']);
  });

  it('shows the issues of accessIssues inline, in the plan name', async () => {
    const user = userEvent.setup();
    render(<Harness doc={timed()} open="member" />);
    await user.click(screen.getByRole('switch', { name: 'All zones' }));
    expect(screen.getByText('Off-peak has no zones.')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /Add a zone to Off-peak/ }));
    await user.click(await screen.findByRole('option', { name: 'Pool' }));
    expect(screen.queryByText('Off-peak has no zones.')).not.toBeInTheDocument();
    expect(plans()[0]?.zones).toEqual([{ zone: 'pool' }]);
  });

  it('limits hours of a zone and strikes what falls outside the plan', async () => {
    const user = userEvent.setup();
    let doc = timed();
    doc = applyOp(doc, {
      op: 'access-plan-set',
      id: 'member',
      patch: { zones: [{ zone: 'pool', hours: { mon: ['05:00-07:00', '17:00-19:00'] } }] },
    });
    render(<Harness doc={doc} open="member" />);
    const zone = screen.getByRole('table', { name: 'Pool in Off-peak hours' });
    const struck = within(zone).getByRole('button', { name: 'Monday, 5 PM to 7 PM, edit' });
    expect(struck).toHaveTextContent('Outside the plan');
    expect(
      within(zone).getByRole('button', { name: 'Monday, 5 AM to 7 AM, edit' }),
    ).not.toHaveTextContent('Outside the plan');
    await user.click(screen.getByRole('switch', { name: 'Limit hours' }));
    expect(plans()[0]?.zones[0]).toEqual({ zone: 'pool' });
  });

  it('warns about a zone key the organization does not have, with a way to make it', () => {
    let doc = timed();
    doc = applyOp(doc, {
      op: 'access-plan-set',
      id: 'member',
      patch: { zones: [{ zone: 'sauna' }] },
    });
    render(<Harness doc={doc} open="member" />);
    expect(screen.getByText(/sauna isn't a zone yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create zone' })).toBeInTheDocument();
  });

  it('shows guest terms only for a guest plan', async () => {
    const user = userEvent.setup();
    render(<Harness doc={timed()} open="member" />);
    expect(screen.queryByLabelText('Visit limit')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Guest/ }));
    expect(plans()[0]?.kind).toBe('guest');
    await user.type(screen.getByLabelText('Visit limit'), '5');
    expect(JSON.parse(screen.getByTestId('doc').textContent ?? '[]')[0].visits).toBe(5);
  });

  it('has no accessibility violations with a plan open', async () => {
    const { container } = render(<Harness doc={timed()} open="member" />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
