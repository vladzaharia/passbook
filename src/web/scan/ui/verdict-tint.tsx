export type Tint = 'green' | 'amber' | 'red' | 'slate' | 'none';

const KINDS = ['green', 'amber', 'red', 'slate'] as const;

/**
 * The scrim and one pre-painted wash per kind, so a verdict only changes opacity (80 ms). The ring is a separate top layer (z 40), so the capsule's glass sits between them.
 */
export function VerdictTint({
  tint,
  onDismiss,
}: {
  tint: Tint;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <div aria-hidden className="scan-layer scan-tint" data-tint={tint}>
      <div className="scan-scrim" />
      {KINDS.map((kind) => (
        <div key={kind} className="scan-wash" data-kind={kind} />
      ))}
      {onDismiss && tint !== 'none' ? (
        // A tap on the tint outside the card dismisses the verdict; Done and Esc stay the keyboard way.
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className="scan-tint-dismiss"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  );
}

export function VerdictRing({ tint }: { tint: Tint }) {
  return <div aria-hidden className="scan-layer scan-ring" data-tint={tint} />;
}
