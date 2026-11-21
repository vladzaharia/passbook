import { DEV_COPY, DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { NAV_PATH } from '../pages/layout.tsx';
import { EmptyStage, Layout, Progress, Step, Tag } from './parts.tsx';

const C = QS_COPY.steps;
/** Straight to Polaris ID: the sandbox step is where the page picks up. */
const POLARIS_HERE = `/auth/oidc/start?next=${encodeURIComponent(`${PATHS.quickstart}#sandbox`)}`;

/** Left nav for the page: where to go next, and the guides. On a phone it is the drawer, with the sections first. */
export function QuickstartSide() {
  return (
    <nav className="sidenav" id="dev-menu" aria-label="Quickstart">
      <div className="menu-only stack">
        <h4>Developers</h4>
        {DEV_COPY.nav.map((n) => (
          <a key={n.key} href={NAV_PATH[n.key]}>
            {n.label}
          </a>
        ))}
      </div>
      <div className="stack">
        <h4>Start</h4>
        <a href={PATHS.quickstart} aria-current="page">
          {QS_COPY.nav}
        </a>
        <a href={PATHS.playground}>Playground</a>
        <a href={PATHS.console}>Console</a>
        <a href={PATHS.webhooks}>Webhook tester</a>
      </div>
      <div className="stack">
        <h4>Guides</h4>
        {DEV_GUIDES.slice(0, 6).map((g) => (
          <a key={g.id} href={`${PATHS.guides}#${g.id}`}>
            {g.title}
          </a>
        ))}
      </div>
    </nav>
  );
}

/**
 * What a signed-out visitor, or a browser without script, sees: the five steps with the first one to do. The
 * `quickstart` island replaces it when there is a session.
 */
export function QuickstartView() {
  return (
    <div data-island="quickstart">
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
            <Step n={5} state="todo" title={C.home.title}>
              <p className="sm muted">{C.home.line}</p>
            </Step>
          </>
        }
        stage={<EmptyStage line={QS_COPY.signedOutStage} />}
      />
    </div>
  );
}
