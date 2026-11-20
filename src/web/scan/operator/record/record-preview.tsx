import { scanLine } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { type SearchResult, statePill } from '../lists/search-results.tsx';
import { RecordBand } from './record-band.tsx';
import { RecordIdentity } from './record-identity.tsx';
import type { Band, Presence } from './record-model.ts';

type Row = SearchResult['items'][number];
const R = OPERATOR_COPY.record;
const BAND: Band = { tone: 'preview', title: R.preview, sub: null, pill: null, at: null };

/**
 * A highlighted search hit, drawn from the search row. Nothing is asked of the server: a resolve
 * shows up as a live row on monitors, and arrowing through eight hits is not eight lookups.
 */
export function RecordPreview({ row, timeZone }: { row: Row; timeZone: string | undefined }) {
  const pill = statePill(row, timeZone);
  const presence: Presence | null = row.doorState
    ? {
        state: row.doorState,
        line: row.lastScanAt
          ? scanLine(R.since, { time: sessionTime(row.lastScanAt, timeZone) })
          : null,
      }
    : null;
  return (
    <div className="op-rec-wrap">
      <article className="op-rec" data-tone="preview" data-source="preview" data-testid="op-record">
        <RecordBand
          band={BAND}
          where={null}
          timeZone={timeZone}
          undo={null}
          kind="ready"
          reason={null}
        />
        <RecordIdentity
          who={{
            name: row.title,
            meta:
              [row.templateName, row.subtitle, row.maskedEmail].filter(Boolean).join(' · ') || null,
            chips:
              pill && row.status !== 'active'
                ? [{ id: 'state', text: pill.text, tone: 'neutral', icon: null }]
                : [],
            photoUrl: row.photoUrl,
            photoAlt: row.title,
          }}
          presence={row.status === 'active' ? presence : null}
          photo={null}
        />
      </article>
    </div>
  );
}
