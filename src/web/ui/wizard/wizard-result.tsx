import type { ReactNode } from 'react';
import { Button } from '../button.tsx';

export interface WizardResultProps {
  /** The outcome: "Copy your key". */
  title: string;
  /** The entity's glyph doing its verb; it plays its done motion once. */
  icon?: ReactNode;
  /** A Done button. Leave it out when the body has its own gate (SecretReveal). */
  onDone?: () => void;
  /** A reveal (secret, link, QR, pairing) or a report. */
  children: ReactNode;
}

/** The icon and title as the dialog's heading. */
export function WizardResultTitle({ title, icon }: Pick<WizardResultProps, 'title' | 'icon'>) {
  return (
    <span className="inline-flex items-center gap-2">
      {icon ? (
        <span data-verb-done="" className="inline-flex text-accent-fg [&>svg]:size-4">
          {icon}
        </span>
      ) : null}
      {title}
    </span>
  );
}

/**
 * What a wizard ends in when it has something to hand over. A WizardDialog takes this element as
 * its `result`, shows the title in its header and the children under it.
 */
export function WizardResult({ children, onDone }: WizardResultProps) {
  return (
    <div className="flex flex-col gap-4">
      {children}
      {onDone ? (
        <div className="flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      ) : null}
    </div>
  );
}
