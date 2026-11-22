import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import '../../lib/test-utils.tsx';
import {
  assignCmd,
  bindResultOf,
  cardReadEvent,
  inspectOf,
  run,
  tagOf,
  tagReadEvent,
} from '../machine/assign.test-support.ts';
import { assignOf } from '../machine/assign-view.ts';
import { fixtureState } from '../machine/fixtures.test-support.ts';
import { at, resetIds, step } from '../machine/reduce.test-support.ts';
import type { ScanState } from '../machine/types.ts';
import { AssignCard } from './assign-card.tsx';
import { AssignDock } from './assign-dock.tsx';

beforeEach(resetIds);

/** The card and its dock, driven by the real reducer: what a Desk sees through a move. */
function Harness({ start, sent }: { start: ScanState; sent: unknown[] }) {
  const [state, setState] = useState(start);
  const a = assignOf(state);
  if (!a) return <p>closed</p>;
  const dispatch = (event: Parameters<typeof step>[1]) => {
    const r = step(state, event, at(900));
    sent.push(...r.cmds);
    setState(r.state);
  };
  const noop = () => undefined;
  return (
    <>
      <AssignCard
        a={a}
        ctx={{
          org: 'Northwind',
          reader: { kind: 'continuous', needsStart: false },
          manager: false,
          managers: [],
          code: true,
          knownName: null,
          readerNote: null,
          webStatus: 'idle',
        }}
        on={{
          scope: (scope) => dispatch({ type: 'assign.scope', scope }),
          label: noop,
          approve: (staffId, pin) =>
            dispatch({ type: 'assign.approve', ...(staffId ? { staffId } : {}), pin }),
          closePin: () => dispatch({ type: 'assign.pin', open: false }),
          lookUp: noop,
        }}
      />
      <AssignDock
        a={a}
        reader={{ kind: 'continuous', needsStart: false }}
        manager={false}
        webStatus="idle"
        on={{
          cancel: noop,
          back: noop,
          done: noop,
          again: noop,
          bind: (move) => dispatch({ type: 'assign.bind', ...(move ? { move: true } : {}) }),
          askManager: () => dispatch({ type: 'assign.pin', open: true, move: true }),
          retry: noop,
          readTag: noop,
          startNfc: noop,
          lookUp: noop,
        }}
      />
    </>
  );
}

describe('a Desk moves a lost tag', () => {
  it('finishes after one PIN, not an endless Ask a manager', () => {
    const started = fixtureState({ started: true, camera: 'live' });
    const opened = step(started, { type: 'assign.open', from: 'menu' }, at(0)).state;
    const r1 = run(opened, [100, tagReadEvent(tagOf())]);
    const r2 = run(r1.state, [
      200,
      {
        type: 'assign.inspected',
        key: assignCmd(r1.cmds, 'assign.inspect').key,
        result: inspectOf(),
      },
    ]);
    const r3 = run(r2.state, [300, cardReadEvent()]);
    const r4 = run(r3.state, [
      400,
      {
        type: 'assign.previewed',
        key: assignCmd(r3.cmds, 'assign.bind').key,
        result: bindResultOf({ warnings: ['lost'], lostAt: 5 }),
      },
    ]);
    const sent: unknown[] = [];
    render(<Harness start={r4.state} sent={sent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask a manager' }));
    const field = screen.getByTestId('scan-approval').querySelector('input') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '123456' } });
    fireEvent.submit(screen.getByTestId('scan-approval'));
    const bind = sent.find(
      (c) => (c as { c: string; body?: { preview?: boolean } }).c === 'assign.bind' && true,
    ) as { body: { preview: boolean; move?: boolean; approval?: { pin: string } } } | undefined;
    expect(bind?.body).toMatchObject({ preview: false, move: true, approval: { pin: '123456' } });
    // One request is in flight: no second Ask a manager, no preview sent again.
    expect(screen.queryByRole('button', { name: 'Ask a manager' })).toBeNull();
    expect(sent.filter((c) => (c as { c: string }).c === 'assign.bind')).toHaveLength(1);
  });
});
