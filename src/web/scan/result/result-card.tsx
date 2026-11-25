import { Info } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { SCAN_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { SCAN_TRAY_COPY } from '../../../shared/copy/scan-tray.ts';
import { Button } from '../../ui/button.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { TagFlag } from '../assign/tag-flag.tsx';
import { tagReasonLine } from '../assign/tag-lines.ts';
import { DisplayPanels } from '../display/display-panels.tsx';
import { scanIcon } from '../display/icons.ts';
import { accessLines, directionPill } from '../machine/access-view.ts';
import { admitLine } from '../machine/admit-line.ts';
import type { Draft, PinNote, ScanOutcome } from '../machine/types.ts';
import { verdictLine } from '../machine/verdict-lines.ts';
import { AddPhoto } from './add-photo.tsx';
import { ApprovalSheet } from './approval-sheet.tsx';
import { GlanceTail } from './glance-tail.tsx';
import { GroupChip } from './group-chip.tsx';
import { IdentityRow } from './identity-row.tsx';
import { isDenied, outcomeNotes } from './notes.ts';
import { useScrollCue } from './use-scroll-cue.ts';
import { ValuePicker } from './value-picker.tsx';
import { VerdictBand } from './verdict-band.tsx';
import './result.css';
import './identity.css';
import './motion.css';
import './result-glance.css';
import './result-keyfact.css';

export function ResultCard({
  outcome: o,
  phase,
  onAction,
  onGroup,
  eventNote,
  holdMs,
  onPass,
  clock,
  desk,
  tagRead = false,
  addPhoto,
  density = 'full',
  approvedBy,
}: {
  /** `glance` is the handheld's card: verdict, who, one fact. The rest is in the pass sheet. */
  density?: 'full' | 'glance';
  /** Set when this device may add photos: the desk card offers it for a pass with none. */
  addPhoto?: ScanApi | undefined;
  /** A Manager's PIN let this one through: the sub names them. */
  approvedBy?: string | undefined;
  /** The scan was a tag read: an unknown one has its own words. */
  tagRead?: boolean;
  outcome: ScanOutcome;
  phase?: string;
  onAction?: (actionId: string) => void;
  onGroup?: () => void;
  eventNote?: string | null;
  holdMs?: number | null;
  onPass?: (card: ScanCard | null, outcome: ScanOutcome) => void;
  /** The machine's clock, for "3 min ago". */
  clock?: number;
  /** The desk's value regions: the open picker, and a Manager's PIN for a `needs_approval` verdict. */
  desk?: {
    picker: Draft | null;
    onAmount: (value: number | null) => void;
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
  useScrollCue(root);
  const refused = desk?.note;
  // A refused PIN brings the sheet back with the tries left.
  useEffect(() => {
    if (refused) setPin(true);
  }, [refused]);
  const d = o.display;
  const ok = o.kind === 'ok';
  const chip = (ok || o.kind === 'heads_up') && Boolean(o.bundle || o.group);
  // A read saved offline is a check-in the door has taken: it wears the green verdict.
  const shown = o.kind === 'queued' ? 'ok' : o.kind;
  const ready = o.kind === 'ready';
  const noExit =
    o.reason === 'not_accepted' && o.checkIn?.direction === 'out' && o.checkIn.mode !== 'in_out';
  const noReentry =
    o.reason === 'already_done' && o.checkIn?.mode === 'in_out' && !o.checkIn.inside;
  const now = o.at ?? 0;
  const line =
    tagReasonLine(o, tagRead) ??
    verdictLine(o, clock ?? Date.now(), {
      desk: desk?.approvals === 'desk',
      group: density === 'glance',
      short: density === 'glance',
    });
  const held = accessLines(o, now);
  const admit = admitLine(o);
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
  // After Check in more the word counts them: Checked in 3 more.
  const grouped = ok && Boolean(o.group) && density === 'glance' && !held && line;
  const title = noExit
    ? 'Check-out not allowed'
    : noReentry
      ? 'No re-entry'
      : grouped
        ? grouped.headline
        : systemTitle;
  // The verdict word is always the headline; a template's own line sits under it.
  const glance = density === 'glance' && !ready;
  const nameInBand = custom && !glance && Boolean(d) && d?.header.title === d?.identity.holder;
  const customLine =
    custom && !noExit && !noReentry && !(glance && d?.header.title === d?.identity.holder)
      ? d?.header.title
      : null;
  const CustomGlyph = ok && !glance && d?.header.icon ? scanIcon(d.header.icon) : null;
  const layout =
    custom && !glance ? 'custom' : shown === 'ok' || shown === 'heads_up' ? 'row' : 'stack';
  const denied = isDenied(o, now);
  // A saved read says what is true: the server has not confirmed it yet.
  const notes =
    glance && o.kind === 'queued'
      ? [SCAN_HANDHELD_COPY.queue.notConfirmedNote]
      : outcomeNotes(o, d, eventNote, denied);
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
      data-kind={shown}
      data-density={glance ? 'glance' : undefined}
      data-phase={phase}
      data-screen={d?.screen ?? o.kind}
      data-reason={o.reason}
      data-milestone={o.milestone || undefined}
      data-testid="scan-result"
      aria-labelledby="scan-result-heading"
    >
      {!ready ? (
        <VerdictBand
          kind={shown}
          layout={layout}
          reason={o.reason}
          phase={phase}
          screen={d?.screen ?? o.kind}
          scanId={o.scanId}
          title={title}
          customLine={customLine}
          CustomGlyph={CustomGlyph}
          noExit={noExit}
          noReentry={noReentry}
          pill={pill}
          sub={
            approvedBy && ok
              ? scanLine(SCAN_TRAY_COPY.pin.approvedBy, { staff: approvedBy })
              : held
                ? held.sub
                : line?.sub
          }
          admit={admit}
          holdMs={holdMs}
          saved={o.kind === 'queued'}
        />
      ) : (
        <h1 className="scan-ready-heading" id="scan-result-heading" tabIndex={-1}>
          Choose an action
        </h1>
      )}
      {d || o.card || o.tag || notes.length || chip ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the card's own button (below) is the keyboard path; this makes the scrolled body tappable too
        // biome-ignore lint/a11y/useKeyWithClickEvents: as above
        <div
          className="scan-result-body"
          data-density={glance ? 'glance' : undefined}
          onClick={
            glance && (o.card || o.scanId)
              ? (e) => {
                  if (!(e.target as HTMLElement).closest('button, a')) onPass?.(o.card, o);
                }
              : undefined
          }
        >
          <IdentityRow
            outcome={o}
            display={d}
            hideName={nameInBand}
            compact={denied}
            glance={glance}
            onPass={() => {
              onPass?.(o.card, o);
            }}
          />
          {ready && o.card && addPhoto && !d?.identity.photo?.url ? (
            <AddPhoto api={addPhoto} passId={o.card.passId} />
          ) : null}
          {o.tag ? (
            <TagFlag
              tag={o.tag}
              holder={d?.identity.holder ?? o.card?.title}
              refused={o.kind === 'refused'}
            />
          ) : null}
          {!glance && d && !denied && !desk?.picker && !o.group ? (
            <DisplayPanels display={d} />
          ) : null}
          {!glance && notes.length ? (
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
          {glance ? (
            <GlanceTail
              outcome={o}
              display={d}
              denied={denied}
              notes={notes}
              chip={chip}
              onGroup={onGroup}
            />
          ) : chip ? (
            <GroupChip outcome={o} onGroup={onGroup} />
          ) : null}
          {o.reason === 'needs_approval' && desk && o.approvals && !glance ? (
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
      {glance && (o.card || o.scanId) ? (
        <button
          type="button"
          className="scan-glance-open"
          aria-label={[
            title,
            o.display?.identity.holder ?? o.card?.title,
            SCAN_HANDHELD_COPY.details,
          ]
            .filter(Boolean)
            .join('. ')}
          onClick={() => onPass?.(o.card, o)}
        />
      ) : null}
    </section>
  );
}
