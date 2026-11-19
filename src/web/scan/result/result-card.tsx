import { Info } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { TagFlag } from '../assign/tag-flag.tsx';
import { tagReasonLine } from '../assign/tag-lines.ts';
import { DisplayPanels } from '../display/display-panels.tsx';
import { scanIcon } from '../display/icons.ts';
import { accessLines, directionPill } from '../machine/access-view.ts';
import type { Draft, PinNote, ScanOutcome } from '../machine/types.ts';
import { verdictLine } from '../machine/verdict-lines.ts';
import { ApprovalSheet } from './approval-sheet.tsx';
import { IdentityRow } from './identity-row.tsx';
import { ValuePicker } from './value-picker.tsx';
import { VerdictGlyph } from './verdict-glyph.tsx';
import './result.css';
import './identity.css';
import './motion.css';

export function ResultCard({
  outcome: o,
  phase,
  onAction,
  eventNote,
  holdMs,
  onPass,
  clock,
  desk,
  tagRead = false,
}: {
  /** The scan was a tag read: an unknown one has its own words. */
  tagRead?: boolean;
  outcome: ScanOutcome;
  phase?: string;
  onAction?: (actionId: string) => void;
  eventNote?: string | null;
  holdMs?: number | null;
  onPass?: (card: ScanCard | null) => void;
  /** The machine's clock, for "3 min ago". */
  clock?: number;
  /** The desk's value regions: the open picker, and a Manager's PIN for a `needs_approval` verdict. */
  desk?: {
    picker: Draft | null;
    onAmount: (value: number) => void;
    onValue: (value: unknown) => void;
    onConfirm: () => void;
    onCancel: () => void;
    managers: { id: string; name: string }[];
    /** Staff sign-in is off: the PIN is a manager code, no name picked. */
    code?: boolean;
    /** Whose PIN approves here; Desk staff too changes the words. */
    approvals?: 'managers' | 'desk';
    /** The last PIN was refused. */
    note?: PinNote | undefined;
    onApprove: (staffId: string | undefined, pin: string) => void;
  };
}) {
  const [pin, setPin] = useState(false);
  const root = useRef<HTMLElement>(null);
  const refused = desk?.note;
  // A refused PIN brings the sheet back with the tries left.
  useEffect(() => {
    if (refused) setPin(true);
  }, [refused]);
  const d = o.display;
  const ok = o.kind === 'ok';
  const ready = o.kind === 'ready';
  const noExit =
    o.reason === 'not_accepted' && o.checkIn?.direction === 'out' && o.checkIn.mode !== 'in_out';
  const noReentry =
    o.reason === 'already_done' && o.checkIn?.mode === 'in_out' && !o.checkIn.inside;
  const now = o.at ?? 0;
  const line =
    tagReasonLine(o, tagRead) ??
    verdictLine(o, clock ?? Date.now(), { desk: desk?.approvals === 'desk' });
  const held = accessLines(o, now);
  const pill = directionPill(o);
  const systemTitle =
    o.action?.id === 'undo'
      ? 'Undone'
      : held
        ? held.title
        : ok
          ? o.action?.kind === 'check_in'
            ? o.checkIn?.direction === 'out'
              ? 'Checked out'
              : SCAN_COPY.verdict.checkedIn
            : (o.action?.label ?? 'Done')
          : line
            ? line.headline
            : 'Choose an action';
  const custom =
    ok &&
    Boolean(d?.header.title) &&
    o.action?.id !== 'undo' &&
    o.checkIn?.direction !== 'out' &&
    pill !== 'out';
  const title = noExit ? 'Check-out not allowed' : noReentry ? 'No re-entry' : systemTitle;
  // The verdict word is always the headline; a template's own line sits under it.
  const customLine = custom && !noExit && !noReentry ? d?.header.title : null;
  const nameInBand = custom && Boolean(d) && d?.header.title === d?.identity.holder;
  const CustomGlyph = ok && d?.header.icon ? scanIcon(d.header.icon) : null;
  const layout = custom ? 'custom' : o.kind === 'ok' || o.kind === 'heads_up' ? 'row' : 'stack';
  // A refusal or a hold (gym full, already in) changed nothing: no stamp, balance or staff note
  // for a grant, so the card cannot read as granted.
  const denied =
    o.kind === 'refused' || (o.kind === 'heads_up' && (Boolean(held) || Boolean(o.occupancy)));
  const notes = [
    ...new Set(
      [
        o.kind === 'refused' ? d?.notes.refused : denied ? null : d?.notes.staff,
        o.kind === 'refused' || o.kind === 'heads_up' ? eventNote : null,
      ].filter(Boolean),
    ),
  ];
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || phase !== 'rising' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const pass = document.querySelector('.scan-buddy-seat');
    if (!pass) return;
    const from = pass.getBoundingClientRect();
    el.style.animation = 'none';
    const to = el.getBoundingClientRect();
    el.style.setProperty('--fx', `${from.left + from.width / 2 - to.left - to.width / 2}px`);
    el.style.setProperty('--fy', `${from.top + from.height / 2 - to.top - to.height / 2}px`);
    el.style.setProperty('--sx', String(48 / to.width));
    el.style.setProperty('--sy', String(64 / to.height));
    el.style.animation = '';
  }, [phase]);
  return (
    <section
      ref={root}
      className="scan-result"
      data-kind={o.kind}
      data-phase={phase}
      data-screen={d?.screen ?? o.kind}
      data-reason={o.reason}
      data-milestone={o.milestone || undefined}
      data-testid="scan-result"
      aria-labelledby="scan-result-heading"
    >
      {!ready ? (
        <div
          className="scan-result-band"
          data-layout={layout}
          data-testid="scan-verdict"
          data-kind={o.kind}
          data-reason={o.reason}
          data-phase={phase}
          data-screen={d?.screen ?? o.kind}
        >
          <div className="scan-glyph-row">
            {CustomGlyph ? (
              <span className="scan-custom-glyph">
                <CustomGlyph aria-hidden />
                <span className="scan-custom-badge">
                  <VerdictGlyph kind="ok" />
                </span>
              </span>
            ) : (
              <VerdictGlyph kind={o.kind} />
            )}
          </div>
          <div className="scan-verdict-text">
            <h1 id="scan-result-heading" tabIndex={-1}>
              {title}
            </h1>
            {customLine ? <p className="scan-verdict-custom">{customLine}</p> : null}
            {noExit ? (
              <p>{SCAN_COPY.verdict.noExitSub}</p>
            ) : noReentry ? (
              <p>{SCAN_COPY.verdict.noReentrySub}</p>
            ) : pill || held?.sub || line?.sub ? (
              <p>
                {pill ? (
                  <span className="scan-dir-pill" data-dir={pill} data-testid="scan-dir-pill">
                    {SCAN_COPY.direction[pill]}
                  </span>
                ) : null}
                {held ? held.sub : (line?.sub ?? null)}
              </p>
            ) : null}
          </div>
          {holdMs ? (
            <span
              key={o.scanId}
              aria-hidden
              className="scan-hold-rail"
              style={{ animationDuration: `${holdMs}ms` }}
            />
          ) : null}
        </div>
      ) : (
        <h1 className="scan-ready-heading" id="scan-result-heading" tabIndex={-1}>
          Choose an action
        </h1>
      )}
      {d || o.card || o.tag || notes.length ? (
        <div className="scan-result-body">
          <IdentityRow
            outcome={o}
            display={d}
            hideName={nameInBand}
            compact={denied}
            onPass={() => {
              onPass?.(o.card);
            }}
          />
          {o.tag ? (
            <TagFlag
              tag={o.tag}
              holder={d?.identity.holder ?? o.card?.title}
              refused={o.kind === 'refused'}
            />
          ) : null}
          {d && !denied && !desk?.picker ? <DisplayPanels display={d} /> : null}
          {notes.length ? (
            <div className="scan-result-notes">
              <Info size={18} aria-hidden />
              <div>
                {notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </div>
          ) : null}
          {ready && o.card && desk?.picker ? (
            <ValuePicker
              card={o.card}
              draft={desk.picker}
              onAmount={desk.onAmount}
              onValue={desk.onValue}
              onConfirm={desk.onConfirm}
              onCancel={desk.onCancel}
            />
          ) : (
            ready &&
            o.card?.actions.map((action) => (
              <Button
                key={action.id}
                data-testid={`scan-action-${action.id}`}
                variant={action.kind === 'check_in' ? 'primary' : 'outline'}
                disabled={!action.available && action.lock !== 'approval'}
                onClick={() => onAction?.(action.id)}
              >
                {action.label}
              </Button>
            ))
          )}
          {o.reason === 'needs_approval' && desk && o.approvals ? (
            pin ? (
              <ApprovalSheet
                managers={desk.managers}
                code={desk.code ?? false}
                desk={desk.approvals === 'desk'}
                action={o.action?.label}
                note={desk.note}
                onApprove={desk.onApprove}
                onCancel={() => setPin(false)}
              />
            ) : (
              <Button data-testid="scan-manager-pin" onClick={() => setPin(true)}>
                {desk.code ? SCAN_COPY.managerCode.action : SCAN_COPY.actions.managerPin}
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
