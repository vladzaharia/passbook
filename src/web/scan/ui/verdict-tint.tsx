export type Tint = 'green' | 'amber' | 'red' | 'slate' | 'none';

const KINDS = ['green', 'amber', 'red', 'slate'] as const;

/**
 * The scrim and one pre-painted wash per kind, so a verdict only changes opacity (80 ms). The 10 px
 * ring is a separate top layer (z 40), so the capsule's glass sits between them.
 */
export function VerdictTint({ tint }: { tint: Tint }) {
  return (
    <div aria-hidden className="scan-layer scan-tint" data-tint={tint}>
      <div className="scan-scrim" />
      {KINDS.map((kind) => (
        <div key={kind} className="scan-wash" data-kind={kind} />
      ))}
    </div>
  );
}

export function VerdictRing({ tint }: { tint: Tint }) {
  return <div aria-hidden className="scan-layer scan-ring" data-tint={tint} />;
}
