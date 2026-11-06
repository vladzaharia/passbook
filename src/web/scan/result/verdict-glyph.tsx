export function VerdictGlyph({ kind }: { kind: string }) {
  return (
    <svg aria-hidden viewBox="0 0 72 64" className="scan-verdict-glyph">
      {kind === 'ok' ? (
        <circle cx="36" cy="32" r="30" fill="currentColor" />
      ) : kind === 'heads_up' ? (
        <path d="M31 6Q36-2 41 6L70 55Q74 62 65 62H7Q-2 62 2 55Z" fill="currentColor" />
      ) : kind === 'refused' ? (
        <path d="M23 2H49L66 19V45L49 62H23L6 45V19Z" fill="currentColor" />
      ) : (
        <rect x="5" y="1" width="62" height="62" rx="18" fill="currentColor" />
      )}
      <g
        fill="none"
        stroke="var(--v)"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === 'ok' ? (
          <path d="m22 32 10 10 19-20" />
        ) : kind === 'refused' ? (
          <path d="m26 22 20 20m0-20L26 42" />
        ) : (
          <path d="M36 19v16m0 10v1" />
        )}
      </g>
    </svg>
  );
}
