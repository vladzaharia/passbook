import { useCallback, useMemo, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import type { Session } from '../console/session.ts';
import type { CodeLang } from '../playground/hash.ts';
import { beacon } from './beacon.ts';
import { ADMISSIONS, fixFor } from './model.ts';
import { EmptyStage, Layout, Progress, Step, type StepState } from './parts.tsx';
import { Stage } from './stage.tsx';
import { ChangeStep, HomeStep, RunStep, SandboxStep } from './steps.tsx';
import { useElapsed } from './use-clock.ts';
import { useQuickstart } from './use-quickstart.ts';

/** The signed-in quickstart. Five steps; the page counts the ones done and the seconds to the pass being live. */
export function Quickstart({ session }: { session: Exclude<Session, { kind: 'out' }> }) {
  const q = useQuickstart(session);
  const [lang, setLang] = useState<CodeLang>('ts');
  const [admission, setAdmission] = useState<string>(ADMISSIONS[0]);
  const [homed, setHomed] = useState(false);
  const onHome = useCallback(() => {
    if (!homed && q.csrf) beacon(q.csrf, 'home');
    setHomed(true);
  }, [homed, q.csrf]);

  const done = [true, q.sandbox !== null, q.doneAt !== null, q.change.state === 'ok', homed];
  const count = done.filter(Boolean).length;
  const current = done.indexOf(false);
  const stateOf = (i: number): StepState => (done[i] ? 'done' : i === current ? 'current' : 'todo');
  const elapsed = useElapsed(q.viewedAt, q.doneAt === null, q.doneAt);

  const fix = useMemo(() => {
    if (q.session.kind === 'closed') return null;
    if (q.sandbox && !q.templateId)
      return fixFor({ status: 0, code: undefined, detail: '' }, false);
    if (q.run.state === 'fail') return fixFor(q.run.problem, Boolean(q.templateId));
    return null;
  }, [q.session.kind, q.sandbox, q.templateId, q.run]);

  const signed = session.kind !== 'closed';
  return (
    <Layout
      progress={<Progress done={count} elapsed={QS_COPY.elapsed(elapsed)} />}
      steps={
        <>
          <Step n={1} state="done" title={QS_COPY.steps.signIn.title} />
          <SandboxStep q={q} state={stateOf(1)} />
          <RunStep q={q} lang={lang} onLang={setLang} state={stateOf(2)} />
          <ChangeStep
            q={q}
            lang={lang}
            onLang={setLang}
            state={stateOf(3)}
            admission={admission}
            onAdmission={setAdmission}
          />
          <HomeStep
            q={q}
            lang={lang}
            state={stateOf(4)}
            elapsed={QS_COPY.elapsed(elapsed)}
            onHome={onHome}
          />
        </>
      }
      stage={signed ? <Stage q={q} fix={fix} /> : <EmptyStage line={QS_COPY.signedOutStage} />}
    />
  );
}
