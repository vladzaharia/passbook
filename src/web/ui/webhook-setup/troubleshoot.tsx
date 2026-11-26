import { Button } from '../button.tsx';
import { Callout } from '../callout.tsx';
import { Rich } from './rich.tsx';
import type { Trouble, TroubleAction } from './troubleshoot-copy.ts';

const ACTION_LABEL: Record<TroubleAction, string> = {
  replaceSecret: 'Replace secret',
  turnOnTestEvents: 'Turn on',
  goToSecret: 'Go to Secret',
  openFailures: 'Open failures',
};

export type TroubleActions = Partial<Record<TroubleAction, () => void>>;

/**
 * What PassBook saw and what to do about it. The action shows only where the host can do it
 * (the wizard passes `goToSecret`; the connection page passes `replaceSecret`).
 */
export function Troubleshoot({
  trouble,
  actions = {},
  id,
  className,
}: {
  trouble: Trouble;
  actions?: TroubleActions;
  id?: string;
  className?: string;
}) {
  const run = trouble.action ? actions[trouble.action] : undefined;
  return (
    <div id={id} className={className}>
      <Callout
        tone={
          trouble.tone === 'success'
            ? 'success'
            : trouble.tone === 'danger'
              ? 'danger'
              : trouble.tone
        }
        title={trouble.title}
        {...(trouble.action && run
          ? {
              actions: (
                <Button variant="outline" size="sm" onClick={run}>
                  {ACTION_LABEL[trouble.action]}
                </Button>
              ),
            }
          : {})}
      >
        <Rich text={trouble.fix} />
      </Callout>
    </div>
  );
}
