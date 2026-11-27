import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { cn } from '../../lib/cn.ts';
import { formatTime } from '../../lib/format.ts';
import type { BuddyScene } from '../art/index.ts';
import { Button } from '../button.tsx';
import { ErrorState } from '../error-state.tsx';
import { type LocalStepDef, useLocalOperation } from '../operation/index.ts';
import { stepItems } from '../operation/steps.ts';
import { StepList, type StepListItem } from '../step-marker.tsx';
import { judge, type Verdict } from './listen-state.ts';
import { LivePanel } from './live-panel.tsx';
import { topicProgress } from './topic-checklist.tsx';
import { type TroubleActions, Troubleshoot } from './troubleshoot.tsx';
import { type InboundContext, inboundTrouble, type Trouble } from './troubleshoot-copy.ts';
import type { Arrival, SetupTopic } from './types.ts';
import { type ArrivalLoader, type FeedMarks, useArrivalFeed } from './use-arrival-feed.ts';

export interface ListenProps {
  mode: 'listen';
  /** "Shopify". */
  provider: string;
  load: ArrivalLoader;
  /** Deliveries before this are not this setup's: the time the provider phase first showed. */
  since: number;
  topics?: readonly SetupTopic[];
  origin?: InboundContext['origin'];
  /** What a real delivery is, in the plural: "orders". Said in the sample note. */
  record?: string;
  /** Accepted deliveries whose work failed: the row says nothing was issued. */
  notIssued?: ReadonlySet<string>;
  /** The guide's `troubleshooting`. */
  recipeFix?: InboundContext['recipeFix'];
  /** The guide's test line: where to press Send test. Shown while nothing has arrived. */
  hint?: ReactNode;
  actions?: TroubleActions;
  zone?: string | undefined;
  marks?: Partial<FeedMarks>;
  /** The phase and the topics seen: the host ticks its checklist and enables Done from this. */
  onChange?: (state: { phase: Verdict['phase']; seen: string[]; verified: Arrival | null }) => void;
  /** An accepted delivery can show what it made. */
  onInspect?: (arrival: Arrival) => void;
  buddy?: boolean;
  className?: string;
}

const STEPS: LocalStepDef[] = [
  { key: 'signature', label: 'Signature' },
  { key: 'event', label: 'Event read' },
];

function words(a: Arrival, ctx: InboundContext): { text: string; bad: boolean } {
  const t = inboundTrouble(a, ctx);
  if (a.outcome === 'rejected') return { text: t.title, bad: true };
  const outcome =
    a.outcome === 'accepted'
      ? t.title === 'Accepted, not issued'
        ? t.title
        : 'Accepted'
      : a.outcome === 'duplicate'
        ? 'Duplicate'
        : t.title;
  return { text: `Signature OK · ${outcome}`, bad: false };
}

/** The Test step: waits on what PassBook actually saw, and says what to do about each outcome. */
export function ListenCheck(props: ListenProps) {
  const { provider, load, since, topics = [], zone = DEFAULT_TIME_ZONE } = props;
  const ctx: InboundContext = {
    provider,
    origin: props.origin ?? 'provider',
    recipeFix: props.recipeFix,
    notIssued: props.notIssued,
  };
  const feed = useArrivalFeed(load, since, props.marks);
  const verdict = useMemo(() => judge(feed.rows, topics), [feed.rows, topics]);
  const def = useMemo(
    () => ({
      kind: `webhook.listen.${provider}`,
      title: `Listen for ${provider}`,
      doneTitle: 'Signed delivery seen',
      steps: [
        { key: 'listen', label: `Listening for ${provider}`, active: `Listening for ${provider}` },
        ...STEPS,
      ],
    }),
    [provider],
  );
  const { operation: op, driver } = useLocalOperation(def, zone);

  const { onChange } = props;
  const changeKey = `${verdict.phase}|${verdict.verified?.id ?? ''}|${verdict.seen.join(',')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the verdict.
  useEffect(
    () => onChange?.({ phase: verdict.phase, seen: verdict.seen, verified: verdict.verified }),
    [changeKey],
  );

  const waiting = useRef(false);
  const finished = useRef(false);
  useEffect(() => {
    if (waiting.current) return;
    waiting.current = true;
    driver.wait('listen', `Listening for ${provider}`);
  }, [driver, provider]);
  useEffect(() => {
    if (!verdict.verified || finished.current) return;
    finished.current = true;
    driver.complete('listen');
    for (const key of ['signature', 'event']) {
      driver.step(key);
      driver.complete(key);
    }
    driver.finish();
  }, [verdict.verified, driver]);

  const signed = verdict.phase === 'signed';
  const quiet = verdict.phase === 'listening';
  const showSlow = quiet && feed.slow;
  const paused = quiet && feed.paused;
  const focus: Arrival | null = signed ? verdict.verified : verdict.rejected;
  const trouble: Trouble | null = showSlow
    ? inboundTrouble(null, ctx)
    : focus &&
        (verdict.phase === 'rejected' || (signed && inboundTrouble(focus, ctx).tone !== 'success'))
      ? inboundTrouble(focus, ctx)
      : null;
  const sample =
    signed &&
    verdict.verified &&
    (verdict.verified.reason === 'ping' || verdict.verified.reason === 'stale');

  const progress = topicProgress(topics, verdict.seen);
  const items: StepListItem[] = stepItems(op, 0, zone).map((item) => {
    if (item.id === 'signature' && verdict.phase === 'rejected')
      return { ...item, state: 'failed', meta: <span className="text-danger">Didn't match</span> };
    if (item.id === 'event' && verdict.verified)
      return {
        ...item,
        detail: [
          verdict.verified.topic,
          words(verdict.verified, ctx).text.replace('Signature OK · ', ''),
        ]
          .filter(Boolean)
          .join(' · '),
      };
    return item;
  });
  if (progress.of > 0)
    items.push({
      id: 'topics',
      label: 'Topics',
      state: progress.seen >= progress.of ? 'done' : 'todo',
      meta: `${progress.seen} of ${progress.of}`,
    });

  const head = feed.error
    ? "Couldn't check for deliveries"
    : paused
      ? 'Paused listening'
      : signed
        ? 'Signed delivery seen'
        : verdict.phase === 'rejected'
          ? (trouble?.title ?? 'Delivery refused')
          : showSlow
            ? 'Nothing arrived yet'
            : 'Listening · nothing yet';
  const say = feed.error
    ? "Couldn't check for deliveries."
    : paused
      ? 'Paused.'
      : signed
        ? `Delivery from ${provider}, signed correctly.${trouble && trouble.tone !== 'success' ? ` ${trouble.title}.` : ''}`
        : verdict.phase === 'rejected'
          ? verdict.rejected?.reason?.startsWith('signature')
            ? "A delivery arrived but its signature didn't match."
            : `A delivery arrived but was refused: ${trouble?.title ?? 'rejected'}.`
          : showSlow
            ? 'Nothing has arrived yet.'
            : `Listening for ${provider}.`;
  const scene: BuddyScene = feed.error
    ? 'beat'
    : signed
      ? 'catch'
      : verdict.phase === 'rejected'
        ? 'inspect'
        : showSlow
          ? 'sweep'
          : paused
            ? 'beat'
            : 'listen';
  const rows = [...feed.rows].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 5);

  return (
    <LivePanel
      label={`Listening for ${provider}`}
      scene={scene}
      mood={signed ? 'happy' : verdict.phase === 'rejected' ? 'sad' : 'curious'}
      buddy={props.buddy !== false && !feed.error}
      say={say}
      sayKey={`${feed.error ? 'error' : paused ? 'paused' : showSlow ? 'slow' : verdict.phase}|${verdict.verified?.id ?? verdict.rejected?.id ?? ''}`}
      className={props.className}
    >
      {feed.error ? (
        <ErrorState inline error={feed.error} subject="deliveries" onRetry={feed.retry} />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h4 className="text-base font-semibold text-fg-strong">{head}</h4>
            {quiet && !paused && props.hint ? (
              <p className="text-sm text-fg-muted">{props.hint}</p>
            ) : null}
            {sample ? (
              <p className="text-sm text-fg-muted">
                Samples prove the setup. Real {props.record ?? 'records'} issue passes.
              </p>
            ) : null}
          </div>
          <StepList label="Checks" items={items} />
          {rows.length > 0 ? (
            <ul
              aria-label="Seen"
              className="flex flex-col divide-y divide-border rounded-md border border-border"
            >
              {rows.map((a) => {
                const w = words(a, ctx);
                return (
                  <li
                    key={a.id}
                    className="ws-row-in flex flex-wrap items-baseline gap-x-2 px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-xs text-fg-strong">{a.topic ?? 'unknown'}</span>
                    <span className={cn('min-w-0 flex-1', w.bad ? 'text-danger' : 'text-fg-muted')}>
                      {w.text}
                      {a.count && a.count > 1 ? ` · ${a.count} times` : ''}
                    </span>
                    <span className="text-xs tabular-nums text-fg-muted">
                      {formatTime(a.receivedAt, zone)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {trouble ? <Troubleshoot trouble={trouble} actions={props.actions} /> : null}
          {paused ? (
            <div>
              <Button variant="outline" onClick={feed.resume}>
                Resume
              </Button>
            </div>
          ) : null}
          {signed && verdict.verified?.outcome === 'accepted' && props.onInspect ? (
            <div>
              <Button
                variant="outline"
                onClick={() => props.onInspect?.(verdict.verified as Arrival)}
              >
                Check what it made
              </Button>
            </div>
          ) : null}
        </>
      )}
    </LivePanel>
  );
}
