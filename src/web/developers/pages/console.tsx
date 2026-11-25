import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { SIGN_IN } from './layout.tsx';
import { Head } from './more.tsx';

/** `/developers/console`: the full-page builder. Signed out, the ticket below is the whole page. */
export function ConsoleView() {
  const c = DEV_COPY.console;
  return (
    <>
      <Head title={c.title} />
      <div className="console-slot try" data-island="run" data-mode="console">
        <div className="card card-b stack g3">
          <p className="muted sm">{c.placeholder}</p>
          <a className="btn" href={SIGN_IN}>
            {c.signIn}
          </a>
        </div>
      </div>
    </>
  );
}
