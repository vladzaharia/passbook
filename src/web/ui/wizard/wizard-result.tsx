import { type ReactNode, useRef } from 'react';
import { Button } from '../button.tsx';
import { DialogContent } from '../dialog.tsx';

/** What a finish hands over: the dialog shows the title and icon in its header and the body under it. */
export interface ResultSpec {
  /** The outcome: "Copy your key". */
  title: string;
  /** The entity's glyph doing its verb; it plays its done motion once. */
  icon?: ReactNode;
  /** A reveal (secret, link, QR, pairing) or a report. */
  body: ReactNode;
  /** A Done button under the body. Leave it out when the body has its own gate (SecretReveal). */
  onDone?: () => void;
}

/** The icon and title as the dialog's heading. */
export function WizardResultTitle({ title, icon }: Pick<ResultSpec, 'title' | 'icon'>) {
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
 * The dialog panel both shells show in place of their form once a result arrives: md, the
 * result's own title with focus on it, no X, and Esc and outside clicks ignored. Render it inside
 * a `Dialog` whose onOpenChange does nothing.
 */
export function ResultDialogContent({ result }: { result: ResultSpec }) {
  const title = useRef<HTMLSpanElement>(null);
  return (
    <DialogContent
      size="md"
      closeButton={false}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        title.current?.focus({ preventScroll: true });
      }}
      title={
        <span ref={title} tabIndex={-1} className="outline-none">
          <WizardResultTitle title={result.title} icon={result.icon} />
        </span>
      }
      onInteractOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
    >
      <div className="flex flex-col gap-4">
        {result.body}
        {result.onDone ? (
          <div className="flex justify-end">
            <Button onClick={result.onDone}>Done</Button>
          </div>
        ) : null}
      </div>
    </DialogContent>
  );
}
