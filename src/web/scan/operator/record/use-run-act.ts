import { type RefObject, useCallback } from 'react';
import type { MachineEvent } from '../../machine/access-events.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import type { ScanRuntime } from '../../platform/runtime.ts';
import type { Act } from './record-model.ts';

export interface RunDeps {
  machine: (event: MachineEvent) => void;
  runtime: ScanRuntime;
  /** Leave the list's record before the machine takes over. */
  release: () => void;
  showPass: (passId: string) => void;
  lookUp: (q: string) => void;
  outcome: ScanOutcome;
  place: string | null;
  markOut: (place: string) => Promise<void>;
  ask: () => void;
  photo: RefObject<HTMLInputElement | null>;
}

/** Each action of the bar, as the machine, the runtime or the workspace takes it. */
export function useRunAct(d: RunDeps) {
  const { machine, runtime, release, showPass, lookUp, outcome, place, markOut, ask, photo } = d;
  return useCallback(
    (act: Act) => {
      const r = act.run;
      switch (r.t) {
        case 'pick':
          return machine({ type: 'pick', actionId: r.actionId });
        case 'group':
          return machine({ type: 'group' });
        case 'override':
          return machine({ type: 'override', actionId: r.actionId });
        case 'turn':
          return machine({ type: 'turn', direction: r.direction });
        case 'ask':
          return ask();
        case 'photo':
          return photo.current?.click();
        case 'mark-out':
          return place ? void markOut(place) : undefined;
        case 'show-pass':
          return showPass(r.passId);
        case 'look-up':
          return lookUp(r.q);
        case 'check-in':
          if (outcome.card) {
            release();
            runtime.checkIn(outcome.card, r.actionId);
          }
          return;
        case 'open':
          release();
          return runtime.emit({ method: 'manual', passId: r.passId });
      }
    },
    [machine, runtime, release, showPass, lookUp, outcome, place, markOut, ask, photo],
  );
}
