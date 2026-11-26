import { useEffect, useRef } from 'react';
import { type LocalOperationDef, useLocalOperation } from '../../../ui/operation/index.ts';
import type { TryPhase } from './try-flow.ts';
import type { Watch } from './try-stage.tsx';

const DEF: LocalOperationDef = {
  kind: 'try.phone',
  title: 'Try on my phone',
  doneTitle: 'On your phone',
  failTitle: 'Could not try on your phone',
  steps: [
    { key: 'release', label: 'Release to Test', active: 'Releasing to Test' },
    { key: 'make', label: 'Make your pass', active: 'Making your pass' },
    { key: 'phone', label: 'Add it to your phone', active: 'Waiting for your phone' },
  ],
};

/** The try flow's phases and the phone watch, as the shared progress panel's operation. */
export function useTryOperation(phase: TryPhase, watch: Watch, zone: string) {
  const { operation, driver } = useLocalOperation(DEF, zone);
  const seen = useRef('');
  const mark = phase.step === 'waiting' ? `waiting|${watch.on}|${watch.gaveUp}` : phase.step;
  useEffect(() => {
    if (seen.current === mark) return;
    seen.current = mark;
    if (driver.snapshot().status === 'failed') driver.retry();
    switch (phase.step) {
      case 'releasing':
        driver.step('release');
        break;
      case 'making':
        driver.complete('release');
        driver.step('make');
        break;
      case 'waiting':
        driver.complete('release');
        driver.complete('make');
        if (watch.on) {
          driver.complete('phone');
          driver.finish();
        } else {
          driver.wait('phone', watch.gaveUp ? 'Not on your phone yet' : 'Waiting for your phone');
        }
        break;
      case 'failed':
        if (phase.at === 'making') driver.complete('release');
        driver.fail(phase.at === 'releasing' ? 'release' : 'make', phase.message);
        break;
    }
  }, [driver, mark, phase, watch.on, watch.gaveUp]);
  return operation;
}
