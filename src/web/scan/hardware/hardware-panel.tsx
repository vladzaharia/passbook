import { Button } from '../../ui/button.tsx';
import { SheetFrame } from '../ui/sheet-frame.tsx';
import { HARDWARE_COPY as C } from './copy.ts';
import { HardwareIcon } from './icons.tsx';
import { isFound } from './items.ts';
import { TestPad, type TestRead } from './test-pad.tsx';
import type { HardwareAction, HardwareItem } from './types.ts';
import './hardware.css';
import './hardware-panel.css';

function Row({
  item,
  testing,
  testRead,
  onAction,
  onTestDone,
}: {
  item: HardwareItem;
  testing: boolean;
  testRead: TestRead | null;
  onAction: (item: HardwareItem, action: HardwareAction) => void;
  onTestDone: () => void;
}) {
  const word = item.status ?? C.states[item.state];
  const action = item.action;
  return (
    <li
      className="hw-row"
      data-state={item.state}
      data-found={isFound(item) ? '' : undefined}
      data-best={item.best ? '' : undefined}
      data-testid={`hw-${item.id}`}
    >
      <span className="hw-tile" aria-hidden>
        <HardwareIcon kind={item.kind} state={item.state} size={20} />
      </span>
      <span className="hw-text">
        <span className="hw-name">{item.name}</span>
        <span className="hw-sub">
          <span className="hw-word">{word}</span>
          {item.detail ? <span> · {item.detail}</span> : null}
        </span>
        {item.how ? <span className="hw-how">{item.how}</span> : null}
      </span>
      {action && !testing ? (
        <Button
          variant={action.kind === 'allow' || action.kind === 'retry' ? 'primary' : 'secondary'}
          size="sm"
          className="hw-act"
          aria-label={`${C.actions[action.kind]} ${item.name}`}
          onClick={() => onAction(item, action)}
        >
          {C.actions[action.kind]}
        </Button>
      ) : null}
      {testing ? <TestPad onDone={onTestDone} external={testRead} /> : null}
    </li>
  );
}

/** Every kind the scanner can use: ways to scan first, each with its instruction, best first. */
export function HardwarePanel({
  items,
  testing,
  testRead = null,
  onAction,
  onTestDone,
  onClose,
}: {
  items: readonly HardwareItem[];
  /** The row whose test pad is open. */
  testing: string | null;
  testRead?: TestRead | null;
  onAction: (item: HardwareItem, action: HardwareAction) => void;
  onTestDone: () => void;
  onClose: () => void;
}) {
  return (
    <SheetFrame label={C.title} onClose={onClose} header={<h2 className="hw-title">{C.title}</h2>}>
      <ul className="hw-list" data-testid="hardware-list">
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            testing={testing === item.id}
            testRead={testRead}
            onAction={onAction}
            onTestDone={onTestDone}
          />
        ))}
      </ul>
    </SheetFrame>
  );
}
