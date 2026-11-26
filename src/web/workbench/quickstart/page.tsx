import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { wbPath } from '../../../shared/workbench.ts';
import { EmptyStage, Layout, Progress, Step, Tag } from './parts.tsx';

const C = QS_COPY.steps;
/** Straight to Polaris ID: the sandbox step is where the page picks up. */
const POLARIS_HERE = `/auth/oidc/start?next=${encodeURIComponent(`${wbPath('', 'quickstart')}#sandbox`)}`;

/** What a signed-out visitor sees: the five steps with the first one to do. The signed-in page replaces it. */
export function QuickstartView() {
  return (
    <div>
      <Layout
        progress={<Progress done={0} elapsed={QS_COPY.elapsed(0)} />}
        steps={
          <>
            <Step n={1} state="current" title={C.signIn.title}>
              <p className="sm muted">{C.signIn.line}</p>
              <p>
                <a className="btn" href={POLARIS_HERE}>
                  {C.signIn.cta}
                </a>
              </p>
            </Step>
            <Step n={2} state="todo" title={C.sandbox.title} tag={<Tag>{C.sandbox.tag}</Tag>}>
              <p className="sm muted">{C.sandbox.line}</p>
            </Step>
            <Step n={3} state="todo" title={C.run.title}>
              <p className="sm muted">
                {C.run.line} <code className="inline-code">Quickstart ticket</code>. {C.run.line2}
              </p>
            </Step>
            <Step n={4} state="todo" title={C.change.title}>
              <p className="sm muted">
                {C.change.line} <code className="inline-code">PATCH /api/v1/passes/{'{id}'}</code>{' '}
                {C.change.line2}
              </p>
            </Step>
            <Step n={5} state="todo" title={QS_COPY.hear.title}>
              <p className="sm muted">{QS_COPY.hear.line}</p>
            </Step>
          </>
        }
        stage={<EmptyStage line={QS_COPY.signedOutStage} />}
      />
    </div>
  );
}
