import { Search } from 'lucide-react';
import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../../shared/contracts/scan-session.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { sessionTime } from '../../ui/session-time.ts';
import { PersonAvatar } from './person-avatar.tsx';
import './lists.css';

export type SearchResult = z.infer<typeof ScanLookupResultSchema>;
type Row = SearchResult['items'][number];
const S = OPERATOR_COPY.search;

export const RESULT_LIST_ID = 'op-results';
export const resultId = (index: number) => `op-result-${index}`;

/** The pill that tells where they are now: In 6:41 PM, Out 5:12 PM, or why they cannot be let in. */
export function statePill(row: Row, timeZone?: string): { text: string; tone: string } | null {
  if (row.status !== 'active')
    return {
      text: S[
        row.status === 'voided' ? 'voided' : row.status === 'removed' ? 'removed' : 'expired'
      ],
      tone: 'muted',
    };
  if (!row.doorState) return null;
  const at = row.lastScanAt ? ` ${sessionTime(row.lastScanAt, timeZone)}` : '';
  return row.doorState === 'in'
    ? { text: `In${at}`, tone: 'success' }
    : { text: `Out${at}`, tone: 'neutral' };
}

export const resultsLine = (n: number) =>
  (n === 1 ? S.results.one : S.results.other).replace('{n}', String(n));

/** Up to 10 people. The field keeps focus; the highlight is `aria-activedescendant`. */
export function SearchResults({
  result,
  busy,
  missed = false,
  highlight,
  hint,
  error,
  wait,
  timeZone,
  onOpen,
}: {
  result: SearchResult | null;
  busy: boolean;
  /** Enter on a code or name found nothing to open. */
  missed?: boolean;
  highlight: number;
  hint: string | null;
  error: string;
  wait: number;
  timeZone?: string | undefined;
  onOpen: (passId: string) => void;
}) {
  const items = result?.items ?? [];
  return (
    <section className="op-list" aria-label="Search results" aria-busy={busy}>
      <p className="sr-only" role="status">
        {result && !busy ? `${resultsLine(items.length)}.` : ''}
      </p>
      <div className="op-list-head">
        <span>{result ? resultsLine(items.length) : (hint ?? '')}</span>
      </div>
      <div className="op-list-scroll">
        {error ? (
          <p role="alert" className="op-list-note" data-tone="no">
            {error}
          </p>
        ) : null}
        {wait > 0 ? (
          <p role="status" className="op-list-note">
            {S.wait.replace('{n}', String(wait))}
          </p>
        ) : null}
        <div id={RESULT_LIST_ID} role="listbox" aria-label="People" className="op-rows">
          {items.map((row, index) => {
            const pill = statePill(row, timeZone);
            const name = row.title;
            const meta = [row.templateName, row.maskedEmail].filter(Boolean).join(' · ');
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys drive the options from the combobox field
              <div
                key={row.passId}
                id={resultId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === highlight}
                className="op-row op-result"
                data-selected={index === highlight || undefined}
                data-muted={row.status !== 'active' || undefined}
                data-testid="op-result"
                onClick={() => onOpen(row.passId)}
              >
                <span className="op-row-main">
                  <PersonAvatar name={name} photoUrl={row.photoUrl} />
                  <span className="op-row-text">
                    <span className="op-row-title" title={name}>
                      {name}
                    </span>
                    <span className="op-row-meta">{meta}</span>
                  </span>
                  {pill ? (
                    <span className="op-pill" data-tone={pill.tone}>
                      {pill.text}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
        {(missed || (result && !items.length)) && !busy ? (
          <div className="op-empty">
            <Search aria-hidden />
            <p className="op-empty-title">{S.none}</p>
            <p>{S.noneHint}</p>
          </div>
        ) : null}
      </div>
      {result ? (
        <div className="op-list-foot">
          <span>{S[result.more ? 'capped' : 'showing'].replace('{n}', String(items.length))}</span>
          <span>{S.clears}</span>
        </div>
      ) : null}
    </section>
  );
}
