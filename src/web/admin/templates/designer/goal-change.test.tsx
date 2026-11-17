import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { TooltipProvider } from '../../../ui/index.ts';
import { applyOp } from './apply.ts';
import { sampleDoc } from './fixtures.ts';
import { GoalChangeDialog } from './goal-change.tsx';
import { useGoalFlow } from './goal-flow.tsx';
import type { DesignDoc } from './model.ts';
import { designerReducer, initialState } from './reducer.ts';
import { readStamps } from './stamps.ts';

const impact = vi.hoisted(() => ({
  data: {
    passes: 40,
    readyNow: 6,
    readyLost: 4,
    newlyReady: 3,
    highest: 15,
    highestKept: 19,
  },
}));
vi.mock('./api.ts', () => ({
  useStampsImpact: () => ({ data: impact.data, isError: false, refetch: vi.fn() }),
}));

beforeEach(() => {
  impact.data = {
    passes: 40,
    readyNow: 6,
    readyLost: 4,
    newlyReady: 3,
    highest: 15,
    highestKept: 19,
  };
});

const dialog = (from: number, to: number, onConfirm = vi.fn()) =>
  render(
    <TooltipProvider>
      <GoalChangeDialog
        templateId="t1"
        from={from}
        to={to}
        open
        saving={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    </TooltipProvider>,
  );

describe('goal change confirm', () => {
  it('says who a lowering alerts, and raises the maximum over a live count', async () => {
    const confirm = vi.fn();
    dialog(10, 6, confirm);
    expect(screen.getByRole('dialog', { name: 'Change the goal to 6?' })).toBeVisible();
    expect(screen.getByText('40 cards are live, 6 cards ready.')).toBeVisible();
    expect(
      screen.getByText('3 cards become ready. Their holders get a Reward ready alert, once.'),
    ).toBeVisible();
    expect(screen.getByText(/maximum is raised to 15/)).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    expect(confirm).toHaveBeenCalledWith({ keepReady: false, maximum: 15 });
  });

  it('keeps rewards ready on a raise by default, and lets them drop silently', async () => {
    const confirm = vi.fn();
    dialog(8, 12, confirm);
    const keep = screen.getByRole('checkbox', { name: 'Keep their rewards ready' });
    expect(keep).toBeChecked();
    expect(screen.getByText(/6 cards stay ready: each gets 4 more stamps/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    expect(confirm).toHaveBeenLastCalledWith({ keepReady: true, maximum: 23 });
    await userEvent.click(keep);
    expect(
      screen.getByText(/4 cards drop to "11 of 12" or less\. Nobody is alerted\./),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }));
    expect(confirm).toHaveBeenLastCalledWith({ keepReady: false, maximum: 23 });
  });

  it('says so when nobody is ready, and has no accessibility violations', async () => {
    impact.data = { ...impact.data, readyNow: 0, readyLost: 0, highest: 4, highestKept: 4 };
    const { baseElement } = dialog(8, 12);
    expect(screen.getByText('No card is ready. Nobody is alerted.')).toBeVisible();
    expect((await axe(baseElement)).violations).toEqual([]);
  });
});

function Flow({
  doc,
  passCount,
  run,
}: {
  doc: DesignDoc;
  passCount: number;
  run: (doc: DesignDoc) => void;
}) {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => initialState(doc));
  const [checking, setChecking] = useState(false);
  const flow = useGoalFlow(
    't1',
    passCount,
    state,
    (op) => {
      dispatch({ type: 'edit', op, at: 1 });
      setChecking(true);
    },
    { saving: false, run: async (d) => run(d) },
    checking,
  );
  return (
    <TooltipProvider>
      <button
        type="button"
        onClick={() => dispatch({ type: 'edit', op: { op: 'stamps-goal', goal: 12 }, at: 1 })}
      >
        Raise
      </button>
      <button type="button" onClick={() => setChecking(false)}>
        Checked
      </button>
      <button type="button" onClick={flow.onSave}>
        Save
      </button>
      {flow.dialog}
    </TooltipProvider>
  );
}

const stampCard = (): DesignDoc => {
  const doc = sampleDoc();
  doc.passJson.storeCard = doc.passJson.generic;
  delete doc.passJson.generic;
  return applyOp(doc, { op: 'stamps-add', art: {} });
};

describe('goal change save', () => {
  it('saves at once without live passes', async () => {
    const run = vi.fn();
    render(<Flow doc={stampCard()} passCount={0} run={run} />);
    await userEvent.click(screen.getByRole('button', { name: 'Raise' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks first, then saves the answered document once its check is back', async () => {
    const run = vi.fn();
    render(<Flow doc={stampCard()} passCount={40} run={run} />);
    await userEvent.click(screen.getByRole('button', { name: 'Raise' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save version' }));
    expect(run).not.toHaveBeenCalled();
    // The dialog makes the page inert; the live check finishing is not a click a person makes.
    fireEvent.click(screen.getByRole('button', { name: 'Checked', hidden: true }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    const saved = run.mock.calls[0]?.[0] as DesignDoc;
    expect(readStamps(saved)).toMatchObject({ goal: 12, keepReady: true });
    const inputs = saved.manifest.inputs as { properties: { stamps: { maximum: number } } };
    expect(inputs.properties.stamps.maximum).toBe(23);
  });
});
