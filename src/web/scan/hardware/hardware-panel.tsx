import { Button } from '../../ui/button.tsx';
import { SheetFrame } from '../ui/sheet-frame.tsx';
import { HARDWARE_COPY as C } from './copy.ts';
import type { GuideStep } from './guide.ts';
import { HardwareIcon, StepIcon } from './icons.tsx';
import { isFound } from './items.ts';
import { TestPad } from './test-pad.tsx';
import type { HardwareAction, HardwareItem } from './types.ts';
import './hardware.css';
import './hardware-panel.css';

function Guide({ steps }: { steps: readonly GuideStep[] }) {
  if (!steps.length) return null;
  return (
    <section className="hw-guide" aria-labelledby="hw-guide-title" data-testid="hardware-guide">
      <h3 id="hw-guide-title">{C.guide.title}</h3>
      <ol>
        {steps.map((step) => (
          <li key={step} data-step={step}>
            <span className="hw-step-icon">
              <StepIcon step={step} />
            </span>
            {C.guide[step]}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Row({
  item,
  testing,
  onAction,
  onTestDone,
}: {
  item: HardwareItem;
  testing: boolean;
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
      {testing ? <TestPad onDone={onTestDone} /> : null}
    </li>
  );
}

/** Every kind the scanner can use, found first; how to scan here on top. */
export function HardwarePanel({
  items,
  steps,
  testing,
  onAction,
  onTestDone,
  onClose,
}: {
  items: readonly HardwareItem[];
  steps: readonly GuideStep[];
  /** The row whose test pad is open. */
  testing: string | null;
  onAction: (item: HardwareItem, action: HardwareAction) => void;
  onTestDone: () => void;
  onClose: () => void;
}) {
  return (
    <SheetFrame label={C.title} onClose={onClose} header={<h2 className="hw-title">{C.title}</h2>}>
      <Guide steps={steps} />
      <ul className="hw-list" data-testid="hardware-list">
        {items.map((item) => (
          <Row
            key={item.id}
            item={item}
            testing={testing === item.id}
            onAction={onAction}
            onTestDone={onTestDone}
          />
        ))}
      </ul>
    </SheetFrame>
  );
}
