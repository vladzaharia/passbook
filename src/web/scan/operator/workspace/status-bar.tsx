import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { Kbd } from './command-field.tsx';

const S = OPERATOR_COPY.status;

export interface KeyHint {
  keys: string;
  label: string;
}

/** Connection and last sync on the left, the keys that work right now on the right. Fine pointer only. */
export function StatusBar({
  online,
  syncedAt,
  place,
  hints,
}: {
  online: boolean;
  syncedAt: number | null;
  place: string;
  hints: readonly KeyHint[];
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a footer is only a landmark directly under body
    <div role="contentinfo" className="op-status" aria-label={OPERATOR_COPY.landmark.status}>
      <span className="op-status-left">
        <span className="op-dot" data-off={online ? undefined : ''} aria-hidden />
        {online ? S.online : S.offline}
        {syncedAt ? ` · ${S.synced.replace('{time}', sessionTime(syncedAt))}` : ''}
        {place ? <span className="op-status-place"> · {place}</span> : null}
      </span>
      <span className="op-status-keys">
        {hints.map((h) => (
          <span key={h.label}>
            <Kbd>{h.keys}</Kbd> {h.label}
          </span>
        ))}
      </span>
    </div>
  );
}
