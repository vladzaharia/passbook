import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../../lib/test-utils.tsx';
import { Card, TooltipProvider } from '../../../ui/index.ts';
import { applyOp } from '../../templates/designer/apply.ts';
import { sampleDoc } from '../../templates/designer/fixtures.ts';
import { defaultValues, type FormValues, validateValues } from '../schema-form/schema.ts';
import { SchemaForm } from '../schema-form/schema-form.tsx';

const zones = vi.hoisted(() => ({ state: 'ok' as 'ok' | 'error' }));
vi.mock('../../scanning/zones-query.ts', () => ({
  useZones: () =>
    zones.state === 'ok'
      ? {
          isSuccess: true,
          isError: false,
          isPending: false,
          data: {
            items: [
              { id: 'z1', key: 'pool', name: 'Pool', depth: 0 },
              { id: 'z2', key: 'studio', name: 'Studio', depth: 0 },
              { id: 'z3', key: 'sauna', name: 'Sauna', depth: 1 },
            ],
          },
        }
      : { isSuccess: false, isError: true, isPending: false, data: undefined },
}));

/** What the designer wrote: a member plan, a timed one, and a guest plan with a default limit. */
function accessSchema() {
  let doc = applyOp(sampleDoc(), { op: 'access-enable' });
  doc = applyOp(doc, { op: 'access-plan-add' });
  doc = applyOp(doc, { op: 'access-plan-set', id: 'plan_2', patch: { label: 'Off-peak' } });
  doc = applyOp(doc, { op: 'access-plan-kind', id: 'plan_2', kind: 'timed' });
  doc = applyOp(doc, { op: 'access-plan-add' });
  doc = applyOp(doc, { op: 'access-plan-set', id: 'plan_3', patch: { label: 'Guest day' } });
  doc = applyOp(doc, { op: 'access-plan-kind', id: 'plan_3', kind: 'guest' });
  doc = applyOp(doc, { op: 'access-plan-set', id: 'plan_3', patch: { visits: 3 } });
  return doc.manifest.inputs as { properties: Record<string, unknown> };
}

function Harness({
  schema = accessSchema(),
  initial,
  onValue,
  ...rest
}: {
  schema?: unknown;
  initial?: FormValues;
  onValue?: (v: FormValues) => void;
} & Partial<React.ComponentProps<typeof SchemaForm>>) {
  const [value, setValue] = useState<FormValues>(initial ?? defaultValues(schema));
  return (
    <TooltipProvider>
      <Card>
        <SchemaForm
          schema={schema}
          value={value}
          onChange={(v) => {
            setValue(v);
            onValue?.(v);
          }}
          {...rest}
        />
      </Card>
    </TooltipProvider>
  );
}

describe('Access plan widget', () => {
  it('create: shows each plan with its summary and starts on the default', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Plan' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: /Member/ })).toBeChecked();
    expect(group).toHaveTextContent('Any time');
    expect(group).toHaveTextContent('Mon–Fri 9 AM–5 PM');
    expect(group).toHaveTextContent('One day · 3 visits');
  });

  it('create: a guest plan reveals the Guest group with the plan limit as the placeholder', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByLabelText('Visit limit')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Guest of')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Guest day/ }));
    expect(screen.getByLabelText('Visit limit')).toHaveAttribute('placeholder', '3');
    expect(screen.getByLabelText('Guest of')).toBeInTheDocument();
  });

  it('create: the Guest group has no empty card until a guest plan is chosen', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('heading', { name: 'Guest' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Guest day/ }));
    expect(screen.getByRole('heading', { name: 'Guest' })).toBeInTheDocument();
  });

  it('create: leaving a guest plan drops the guest settings from the values', async () => {
    const user = userEvent.setup();
    const seen: FormValues[] = [];
    render(<Harness onValue={(v) => seen.push(v)} />);
    await user.click(screen.getByRole('radio', { name: /Guest day/ }));
    await user.type(screen.getByLabelText('Guest of'), 'Maya');
    await user.type(screen.getByLabelText('Visit limit'), '2');
    expect(seen.at(-1)).toMatchObject({ plan: 'plan_3', sponsor: 'Maya', visits: 2 });
    await user.click(screen.getByRole('radio', { name: /Off-peak/ }));
    const last = seen.at(-1) ?? {};
    expect(last.plan).toBe('plan_2');
    expect('sponsor' in last).toBe(false);
    expect('visits' in last).toBe(false);
    expect(screen.queryByLabelText('Guest of')).not.toBeInTheDocument();
  });

  it('shows what the end means for each plan', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByLabelText('No end')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Guest day/ }));
    expect(screen.getByLabelText('Ends at midnight')).toBeInTheDocument();
  });

  it('shows a server message under the plan', () => {
    render(<Harness serverErrors={{ plan: 'Choose a plan of this template.' }} />);
    expect(screen.getByRole('radiogroup', { name: 'Plan' })).toHaveAccessibleDescription(
      'Choose a plan of this template.',
    );
  });

  it('is valid for the form values it builds', () => {
    const schema = accessSchema();
    const values = { ...defaultValues(schema), name: 'Alex' };
    expect(validateValues(schema, values)).toEqual({});
    expect(validateValues(schema, { ...values, zones: ['pool'] })).toEqual({});
  });
});

describe('Access zones widget', () => {
  it('edit: shows the chosen zones by name and removes one', async () => {
    const user = userEvent.setup();
    const seen: FormValues[] = [];
    render(
      <Harness
        initial={{ plan: 'member', zones: ['pool', 'studio'] }}
        onValue={(v) => seen.push(v)}
      />,
    );
    const chosen = screen.getByRole('list', { name: 'Extra zones chosen' });
    expect(chosen).toHaveTextContent('Pool');
    expect(chosen).toHaveTextContent('Studio');
    await user.click(screen.getByRole('button', { name: 'Remove Pool' }));
    expect(seen.at(-1)?.zones).toEqual(['studio']);
    await user.click(screen.getByRole('button', { name: 'Remove Studio' }));
    expect('zones' in (seen.at(-1) ?? {})).toBe(false);
  });

  it('create: adds a zone from the organization list, leaving chosen ones out', async () => {
    const user = userEvent.setup();
    const seen: FormValues[] = [];
    render(<Harness initial={{ plan: 'member', zones: ['pool'] }} onValue={(v) => seen.push(v)} />);
    await user.click(screen.getByRole('combobox', { name: /Extra zones/ }));
    expect(screen.queryByRole('option', { name: 'Pool' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /Sauna/ }));
    expect(seen.at(-1)?.zones).toEqual(['pool', 'sauna']);
  });

  it('says so when the zones cannot be read', () => {
    zones.state = 'error';
    render(<Harness />);
    expect(screen.getByRole('combobox', { name: /Extra zones/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /Extra zones/ })).toHaveTextContent(
      'Zones unavailable',
    );
    zones.state = 'ok';
  });

  it('works for a single zone key held in a text input', async () => {
    const user = userEvent.setup();
    const seen: FormValues[] = [];
    const schema = {
      type: 'object',
      properties: {
        homeClub: { type: 'string', 'x-label': 'Home club', 'x-widget': 'access-zones' },
      },
    };
    render(
      <Harness schema={schema} initial={{ homeClub: 'pool' }} onValue={(v) => seen.push(v)} />,
    );
    const select = screen.getByRole('combobox', { name: 'Home club' });
    expect(select).toHaveTextContent('Pool');
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'None' }));
    expect('homeClub' in (seen.at(-1) ?? {})).toBe(false);
  });
});

describe('Access inputs in a bulk change', () => {
  it('picks the plan of the fields that change, as the composer does', async () => {
    const user = userEvent.setup();
    const seen: FormValues[] = [];
    const all = accessSchema();
    const picked = {
      type: 'object',
      properties: { plan: all.properties.plan, zones: all.properties.zones },
    };
    render(
      <Harness schema={picked} initial={{}} idPrefix="change" onValue={(v) => seen.push(v)} />,
    );
    await user.click(screen.getByRole('radio', { name: /Off-peak/ }));
    expect(seen.at(-1)).toEqual({ plan: 'plan_2' });
    expect(screen.queryByLabelText('Guest of')).not.toBeInTheDocument();
  });
});

describe('Access inputs, accessibility', () => {
  it('has no violations for a guest plan', async () => {
    const { container } = render(<Harness initial={{ plan: 'plan_3', zones: ['pool'] }} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
