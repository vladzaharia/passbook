import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import '../../../lib/test-utils.tsx';
import { TooltipProvider } from '../../../ui/index.ts';
import { applyOp } from './apply.ts';
import { optionsProblem, slugOf } from './choice-model.ts';
import { DesignerProvider } from './context.tsx';
import { sampleDoc } from './fixtures.ts';
import { newInput, readInputs } from './inputs.ts';
import type { DesignDoc, Dict } from './model.ts';
import { designerReducer, initialState } from './reducer.ts';
import { InputsSection } from './section-inputs.tsx';

const withChoice = (): DesignDoc =>
  applyOp(sampleDoc(), {
    op: 'input-add',
    spec: { ...newInput(readInputs(sampleDoc().manifest), 'choice'), name: 'tier', label: 'Tier' },
  });

function Harness({ doc }: { doc: DesignDoc }) {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => ({
    ...initialState(doc),
    select: { section: 'inputs' as const, key: 'tier' },
  }));
  return (
    <DesignerProvider
      value={{
        state,
        doc: state.doc,
        edit: (op, merge) => dispatch({ type: 'edit', op, ...(merge ? { merge } : {}) }),
        select: (select) => dispatch({ type: 'select', select }),
        focusTarget: () => {},
        dispatch,
        assetBase: '/assets',
        readOnly: false,
        stamps: { count: 4, setCount: () => {} },
      }}
    >
      <TooltipProvider>
        <InputsSection />
        <output data-testid="schema">
          {JSON.stringify((state.doc.manifest.inputs as Dict).properties)}
        </output>
        <output data-testid="sample">{JSON.stringify(state.doc.manifest.sample)}</output>
      </TooltipProvider>
    </DesignerProvider>
  );
}

const tier = () =>
  (JSON.parse(screen.getByTestId('schema').textContent ?? '{}') as Record<string, Dict>).tier;

describe('choice input', () => {
  it('writes an enum with labels and a sample from the options', () => {
    const node = (withChoice().manifest.inputs as { properties: Record<string, Dict> }).properties
      .tier;
    expect(node).toMatchObject({
      type: 'string',
      enum: ['option_1', 'option_2'],
      'x-enumLabels': { option_1: 'Option 1', option_2: 'Option 2' },
    });
    expect((withChoice().manifest.sample as Dict).tier).toBe('option_1');
    expect(readInputs(withChoice().manifest).find((s) => s.name === 'tier')).toMatchObject({
      type: 'choice',
      options: [
        { value: 'option_1', label: 'Option 1' },
        { value: 'option_2', label: 'Option 2' },
      ],
    });
  });

  it('reads a hand-written enum as a choice and keeps its labels through JSON', () => {
    const doc = sampleDoc();
    (doc.manifest.inputs as { properties: Dict }).properties.level = {
      type: 'string',
      enum: ['copper', 'blue'],
      'x-enumLabels': { copper: 'Copper' },
    };
    const spec = readInputs(doc.manifest).find((s) => s.name === 'level');
    expect(spec?.type).toBe('choice');
    expect(spec?.options).toEqual([
      { value: 'copper', label: 'Copper' },
      { value: 'blue', label: 'blue' },
    ]);
  });

  it('leaving choice drops the enum', () => {
    const doc = applyOp(withChoice(), { op: 'input-set', name: 'tier', patch: { type: 'text' } });
    const node = (doc.manifest.inputs as { properties: Record<string, Dict> }).properties.tier;
    expect(node).not.toHaveProperty('enum');
    expect(node).not.toHaveProperty('x-enumLabels');
  });

  it('a default or sample outside the options is not written', () => {
    const doc = applyOp(withChoice(), {
      op: 'input-set',
      name: 'tier',
      patch: { default: 'gone', sample: 'gone' },
    });
    const node = (doc.manifest.inputs as { properties: Record<string, Dict> }).properties.tier;
    expect(node).not.toHaveProperty('default');
    expect((doc.manifest.sample as Dict).tier).toBe('option_1');
  });

  it('checks values', () => {
    expect(optionsProblem([])).toMatch(/at least one/);
    expect(optionsProblem([{ value: '', label: 'A' }])).toMatch(/needs a value/);
    expect(
      optionsProblem([
        { value: 'a', label: 'A' },
        { value: 'a', label: 'B' },
      ]),
    ).toMatch(/twice/);
    expect(slugOf(' Free Coffee! ')).toBe('free_coffee');
  });
});

describe('options editor', () => {
  it('adds, renames with the value following, reorders and removes', async () => {
    const user = userEvent.setup();
    render(<Harness doc={withChoice()} />);
    const list = screen.getByRole('list', { name: 'Tier options' });
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    const label = screen.getByRole('textbox', { name: 'Option 1 label' });
    await user.clear(label);
    await user.type(label, 'Gold');
    expect(screen.getByRole('textbox', { name: 'Option 1 value' })).toHaveValue('gold');
    expect(tier()?.enum).toEqual(['gold', 'option_2', 'option_3']);
    expect(JSON.parse(screen.getByTestId('sample').textContent ?? '{}').tier).toBe('gold');
    await user.click(screen.getByRole('button', { name: 'Move option 1 down' }));
    expect(tier()?.enum).toEqual(['option_2', 'gold', 'option_3']);
    await user.click(screen.getByRole('button', { name: 'Remove option 3' }));
    expect(tier()?.enum).toEqual(['option_2', 'gold']);
  });

  it('flags a repeated value and keeps the last option', async () => {
    const user = userEvent.setup();
    render(<Harness doc={withChoice()} />);
    const value = screen.getByRole('textbox', { name: 'Option 2 value' });
    await user.clear(value);
    await user.type(value, 'option_1');
    expect(screen.getByRole('alert')).toHaveTextContent('"option_1" is used twice.');
    await user.click(screen.getByRole('button', { name: 'Remove option 2' }));
    expect(screen.getByRole('button', { name: 'Remove option 1' })).toBeDisabled();
  });

  it('picks the type Choice with starter options', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        doc={applyOp(withChoice(), { op: 'input-set', name: 'tier', patch: { type: 'text' } })}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(screen.getByRole('option', { name: 'Choice' }));
    expect(tier()?.enum).toEqual(['option_1', 'option_2']);
  });

  it('has no axe violations', async () => {
    const { container } = render(<Harness doc={withChoice()} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
