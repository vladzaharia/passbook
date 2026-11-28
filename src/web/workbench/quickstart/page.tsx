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
              <p>
                <a className="btn" href={POLARIS_HERE}>
                  {C.signIn.cta}
                </a>
              </p>
            </Step>
            <Step n={2} state="todo" title={C.sandbox.title} tag={<Tag>{C.sandbox.tag}</Tag>} />
            <Step n={3} state="todo" title={C.run.title}>
              <p className="sm muted">
                <code className="inline-code">POST /api/v1/passes</code>
              </p>
            </Step>
            <Step n={4} state="todo" title={C.change.title}>
              <p className="sm muted">
                <code className="inline-code">PATCH /api/v1/passes/{'{id}'}</code>
              </p>
            </Step>
            <Step n={5} state="todo" title={QS_COPY.hear.title} />
          </>
        }
        stage={<EmptyStage />}
      />
    </div>
  );
}
