import { CircleAlert, Loader2 } from 'lucide-react';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import type { AssignState } from '../machine/assign-state.ts';
import { VerdictGlyph } from '../result/verdict-glyph.tsx';
import { fill } from '../ui/copy.ts';
import { ConfirmBody } from './assign-confirm.tsx';
import { bannerLine, errorLine } from './assign-lines.ts';
import { Identity, OpensLine, StepHeader } from './assign-steps.tsx';
import { TAG_EXTRA_COPY } from './copy.ts';
import { TagArt } from './tag-art.tsx';
import { TagChip } from './tag-chip.tsx';
import type { TagReader } from './tag-reader.ts';
import { useRetryWait } from './use-retry-wait.ts';
import './assign.css';
import './tag-chrome.css';

export type AssignTone = 'ok' | 'heads_up' | 'refused' | 'system' | 'ready';

/** What colour the card and the screen take: green for done, amber, red or slate for an error. */
export function toneOf(a: AssignState): AssignTone {
  if (a.step === 'done') return 'ok';
  if (a.step !== 'error' || !a.error) return 'ready';
  switch (a.error.kind) {
    case 'already_here':
      return 'heads_up';
    case 'lost':
    case 'failed_check':
      return 'refused';
    default:
      return 'system';
  }
}

export interface AssignCardContext {
  org: string;
  reader: TagReader;
  /** The scanner's own role is Manager: Move tag needs no PIN. */
  manager: boolean;
  managers: { id: string; name: string }[];
  code: boolean;
  /** The pass's name when it is known from the start (a result card's Add tag). */
  knownName: string | null;
  /** A one-shot tag read ended without a tag. */
  readerNote: 'cancelled' | 'no_read' | null;
  webStatus: 'idle' | 'on' | 'denied' | 'error';
}

export interface AssignCardHandlers {
  scope(scope: 'pass' | 'user'): void;
  label(label: string): void;
  approve(staffId: string | undefined, pin: string): void;
  closePin(): void;
}

function Headline({ a, ctx }: { a: AssignState; ctx: AssignCardContext }) {
  const c = SCAN_TAG_COPY;
  if (a.waiting) return <>{c.tag.read}</>;
  if (a.step === 'pass')
    return (
      <>
        {ctx.reader.kind === 'sheet' || ctx.reader.kind === 'continuous'
          ? c.pass.scanReader
          : c.pass.scan}
      </>
    );
  switch (ctx.reader.kind) {
    case 'sheet':
      return <>{c.tag.ios}</>;
    case 'wedge':
      return <>{c.tag.usb}</>;
    default:
      return <>{c.tag.hold}</>;
  }
}

/** The step's card body. The dock carries the verbs. */
function Body({ a, ctx, on }: { a: AssignState; ctx: AssignCardContext; on: AssignCardHandlers }) {
  const c = SCAN_TAG_COPY;
  const name = a.request?.holderName ?? ctx.knownName ?? a.preview?.card.holderName ?? null;
  if (a.step === 'confirm')
    return (
      <>
        <StepHeader a={a} />
        <ConfirmBody a={a} manager={ctx.manager} managers={ctx.managers} code={ctx.code} on={on} />
      </>
    );
  const hint = a.tag && a.inspected?.hint ? a.inspected.hint : null;
  return (
    <>
      <StepHeader a={a} />
      {a.request ? (
        <>
          {a.request.requestedByName ? (
            <p className="scan-assign-from">
              {fill(c.request.from, { admin: a.request.requestedByName })}
            </p>
          ) : null}
          <Identity name={a.request.holderName} meta={a.request.passTitle} tile="pass" />
          <OpensLine scope={a.request.scope} name={a.request.holderName} />
        </>
      ) : name ? (
        <>
          <Identity name={name} meta={ctx.knownName ? a.preview?.card.templateName : null} />
          <p className="scan-assign-sub">{fill(c.assigningTo, { name })}</p>
        </>
      ) : null}
      {a.tag && a.step === 'pass' && hint ? (
        <div className="scan-assign-link">
          <TagChip hint={hint} assurance={a.inspected?.assurance ?? 'basic'} />
        </div>
      ) : null}
      {a.waiting ? null : (
        <div className="scan-assign-art">
          <TagArt size={96} />
        </div>
      )}
      <h1 id="scan-result-heading" tabIndex={-1} className="scan-assign-headline">
        <Headline a={a} ctx={ctx} />
      </h1>
      {a.step === 'tag' && ctx.readerNote ? (
        <p className="scan-assign-note" role="status">
          {ctx.readerNote === 'cancelled' ? c.tag.cancelled : c.tag.noRead}
        </p>
      ) : null}
      {a.step === 'tag' && ctx.webStatus === 'denied' ? (
        <p className="scan-assign-note" role="status">
          {TAG_EXTRA_COPY.nfcDenied}
        </p>
      ) : null}
      {a.note ? (
        <p
          className="scan-assign-note"
          data-tone="amber"
          role="status"
          data-testid="scan-assign-note"
        >
          {a.note.kind === 'is_pass' ? c.tag.isPass : c.pass.isTag}
        </p>
      ) : null}
      {a.banner ? (
        <div className="scan-assign-banner" role="alert" data-testid="scan-assign-banner">
          <CircleAlert aria-hidden size={18} />
          <b>{bannerLine(a.banner).headline}</b>
          {bannerLine(a.banner).sub}
        </div>
      ) : null}
      {a.waiting ? (
        <p className="scan-assign-wait" role="status">
          <Loader2 aria-hidden className="wl-spin wl-essential size-4" />
          {c.request.waitingConsole}
        </p>
      ) : null}
      {a.busy && a.busy !== 'bind' ? (
        <p className="scan-assign-wait" role="status">
          <Loader2 aria-hidden className="wl-spin wl-essential size-4" />
          {TAG_EXTRA_COPY.reading}
        </p>
      ) : null}
    </>
  );
}

export function AssignCard({
  a,
  ctx,
  on,
  phase,
}: {
  a: AssignState;
  ctx: AssignCardContext;
  on: AssignCardHandlers;
  phase?: 'rising' | 'up';
}) {
  const tone = toneOf(a);
  const wait = useRetryWait(a.error);
  const line =
    a.step === 'error' && a.error
      ? errorLine(a.error, { org: ctx.org, wait })
      : a.step === 'done' && a.result
        ? {
            headline:
              a.result.status === 'moved' ? SCAN_TAG_COPY.ok.moved : SCAN_TAG_COPY.ok.assigned,
            sub: '',
          }
        : null;
  const done = a.step === 'done' ? a.result : null;
  return (
    <section
      className="scan-result scan-assign"
      data-kind={tone}
      data-step={a.step}
      data-phase={phase ?? 'up'}
      data-source={a.source}
      data-testid="scan-assign"
      aria-label={a.step === 'error' || a.step === 'done' ? undefined : 'Assign tag'}
      aria-labelledby={a.step === 'error' || a.step === 'done' ? 'scan-result-heading' : undefined}
    >
      {line ? (
        <div
          className="scan-result-band"
          data-layout="stack"
          data-testid="scan-verdict"
          data-kind={tone}
        >
          <div className="scan-glyph-row">
            <VerdictGlyph kind={tone} />
          </div>
          <div className="scan-verdict-text">
            <h1 id="scan-result-heading" tabIndex={-1}>
              {line.headline}
            </h1>
            {done ? (
              <p>
                {done.scope === 'user'
                  ? fill(SCAN_TAG_COPY.worksWith.resultPerson, {
                      name: done.card.holderName ?? done.card.title,
                    })
                  : SCAN_TAG_COPY.worksWith.resultPass}
              </p>
            ) : line.sub ? (
              <p>{line.sub}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="scan-result-body scan-assign-body">
        {done ? (
          <>
            <Identity
              name={done.card.holderName ?? done.card.title}
              meta={done.card.templateName}
            />
            <div className="scan-assign-link">
              <TagChip
                hint={done.hint}
                assurance={done.assurance}
                name={a.label.trim() || undefined}
              />
            </div>
            {a.request?.requestedByName ? (
              <p className="scan-assign-sub">
                {fill(SCAN_TAG_COPY.ok.forAdmin, { admin: a.request.requestedByName })}
              </p>
            ) : null}
          </>
        ) : a.step === 'error' ? (
          <div className="scan-assign-art">
            <TagArt size={72} struck={tone === 'refused'} />
          </div>
        ) : (
          <Body a={a} ctx={ctx} on={on} />
        )}
      </div>
    </section>
  );
}
