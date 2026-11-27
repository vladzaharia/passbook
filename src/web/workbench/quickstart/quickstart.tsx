import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { SDK_STATUS } from '../../../shared/developers-sdk.ts';
import {
  onLang as onLangPicked,
  savedLang,
  setLang as setLangEverywhere,
} from '../../developers/shell/language.ts';
import type { Session } from '../console/session.ts';
import { duration } from '../home/model.ts';
import { type CodeLang, LANGS } from '../playground/hash.ts';
import { beacon } from './beacon.ts';
import { RunStep } from './call-step.tsx';
import { ChangeStep } from './change-step.tsx';
import { HearStep } from './hear-step.tsx';
import { ADMISSIONS, fixFor } from './model.ts';
import { EmptyStage, Layout, Progress, Step, type StepState } from './parts.tsx';
import { SandboxStep } from './sandbox-step.tsx';
import { useSinglePoll } from './single-poll.ts';
import { QsTransport } from './transport.tsx';
import { useQuickstart } from './use-quickstart.ts';

// The pass cards, the wallets' previews and the finished page load when there is a pass to draw, not with the steps.
const Stage = lazy(() => import('./stage.tsx').then((m) => ({ default: m.Stage })));
const Done = lazy(() => import('./done.tsx').then((m) => ({ default: m.Done })));

/** curl is the default while no SDK is published: it is the request that runs today. */
const firstLang = (): CodeLang =>
  SDK_STATUS.typescript ? 'ts' : SDK_STATUS.python ? 'py' : SDK_STATUS.go ? 'go' : 'curl';
const isLang = (l: string | null): l is CodeLang => LANGS.some((x) => x === l);
/** The language picked last on any page, else the default. */
const defaultLang = (): CodeLang => {
  const saved = savedLang();
  return isLang(saved) ? saved : firstLang();
};

/** Ticks once a second while `running`, from the server's start: the time the page and the header chip show. */
function useRunTime(startedAt: number | null, skew: number, stopAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null || stopAt !== null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt, stopAt]);
  if (startedAt === null) return 0;
  return Math.max(0, (stopAt ?? now + skew) - startedAt);
}

/**
 * The signed-in quickstart. Five steps whose ticks come from the server (`GET /developer/home`): a reload shows
 * the same page. The page counts the steps done and the time since the track started; Done replaces the steps.
 */
export function Quickstart({
  session,
  onContexts,
}: {
  session: Exclude<Session, { kind: 'out' }>;
  /** A sandbox was made: the shell reads its contexts again. */
  onContexts?: () => void;
}) {
  const q = useQuickstart(session, onContexts);
  const [lang, setLangState] = useState<CodeLang>(defaultLang);
  const setLang = useCallback((l: CodeLang) => {
    setLangState(l);
    setLangEverywhere(l);
  }, []);
  useEffect(
    () =>
      onLangPicked((l) => {
        if (isLang(l)) setLangState(l);
      }),
    [],
  );
  const [admission, setAdmission] = useState<string>(ADMISSIONS[0]);
  /** Left the key box of step 2: the key is on the clipboard or in the .env. */
  const [advanced, setAdvanced] = useState(false);
  /** Null until the first read: a track that was already done opens on the finished page. */
  const [finished, setFinished] = useState<boolean | null>(null);
  const { progress, home } = q;
  useEffect(() => {
    if (finished === null && home) setFinished(home.progress?.doneAt != null);
  }, [finished, home]);
  const onFinish = useCallback(() => {
    setFinished(true);
    if (q.csrf) beacon(q.csrf, 'home');
  }, [q.csrf]);

  const open = home?.state === 'open';
  const done = [
    true,
    open && (q.secret === null || advanced),
    progress?.passAt != null,
    progress?.changeAt != null,
    finished === true,
  ];
  const count = done.filter(Boolean).length;
  const current = done.indexOf(false);
  const stateOf = (i: number): StepState => (done[i] ? 'done' : i === current ? 'current' : 'todo');
  // Calls from a terminal and the webhook that follows tick on the server: read the home again while they are due.
  useSinglePoll('home', open && finished !== true && done[2] === true, q.poll, 6000);
  const elapsed = useRunTime(progress?.startedAt ?? null, q.skew, progress?.doneAt ?? null);

  const fix = useMemo(() => {
    if (q.session.kind === 'closed') return null;
    if (q.sandbox && !q.templateId)
      return fixFor({ status: 0, code: undefined, detail: '' }, false);
    if (q.run.state === 'fail') return fixFor(q.run.problem, Boolean(q.templateId));
    return null;
  }, [q.session.kind, q.sandbox, q.templateId, q.run]);

  const time = duration(elapsed);
  if (finished === true && progress?.doneAt != null)
    return (
      <QsTransport transport={q.transport} csrf={q.csrf}>
        <Layout
          wide
          progress={<Progress done={5} elapsed={time} />}
          steps={
            <Suspense fallback={null}>
              <Done q={q} />
            </Suspense>
          }
        />
      </QsTransport>
    );
  const signed = session.kind !== 'closed';
  return (
    <QsTransport transport={q.transport} csrf={q.csrf}>
      <Layout
        progress={<Progress done={count} elapsed={time} />}
        steps={
          <>
            <Step n={1} state="done" title={QS_COPY.steps.signIn.title} />
            <SandboxStep q={q} state={stateOf(1)} onNext={() => setAdvanced(true)} />
            <RunStep q={q} lang={lang} onLang={setLang} state={stateOf(2)} />
            <ChangeStep
              q={q}
              lang={lang}
              onLang={setLang}
              state={stateOf(3)}
              admission={admission}
              onAdmission={setAdmission}
            />
            <HearStep q={q} state={stateOf(4)} onFinish={onFinish} />
          </>
        }
        stage={
          signed ? (
            <Suspense fallback={<EmptyStage line={QS_COPY.signedOutStage} />}>
              <Stage q={q} fix={fix} />
            </Suspense>
          ) : (
            <EmptyStage line={QS_COPY.signedOutStage} />
          )
        }
      />
    </QsTransport>
  );
}
