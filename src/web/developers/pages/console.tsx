import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { Ticket } from '../ui/ticket.tsx';
import { SIGN_IN } from './layout.tsx';
import { Head } from './more.tsx';

/** `/developers/console`: the full-page builder. Signed out, the ticket below is the whole page. */
export function ConsoleView() {
  const c = DEV_COPY.console;
  return (
    <>
      <Head eyebrow="Tools" title={c.title} line={c.line} />
      <div className="console-slot try" data-island="run" data-mode="console">
        <Ticket
          stub={
            <div className="start">
              <h3 className="h2">{c.signIn}</h3>
              <p className="muted sm">{c.placeholder}</p>
              <a className="btn" href={SIGN_IN}>
                {c.signIn}
              </a>
            </div>
          }
          body={<p className="muted sm resp-hint">{DEV_COPY.reference.tryLine}</p>}
        />
      </div>
    </>
  );
}
