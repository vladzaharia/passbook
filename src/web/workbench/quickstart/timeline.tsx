import { Check, Minus, X } from 'lucide-react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { formatTime } from '../../lib/format.ts';
import type { Call, Caught, QsPass } from './types.ts';

interface Row {
  id: string;
  title: string;
  line: string;
  state: 'done' | 'wait' | 'fail' | 'skip';
  at?: number;
}

const H = QS_COPY.happened;

/** `201 · From your terminal · curl/8.7.1`, or the status and time when it was sent from this page. */
const callLine = (c: Extract<Call, { state: 'ok' }>): string =>
  c.via === 'terminal'
    ? [c.status, QS_COPY.call.from, c.client].filter(Boolean).join(' · ')
    : [c.status, c.ms > 0 ? `${c.ms} ms` : null].filter(Boolean).join(' · ');

/** What the page's calls and the sandbox's endpoint did, in the order they happened. Rows still to come are open circles. */
export function rowsOf(input: {
  run: Call;
  change: Call;
  pass: QsPass | null;
  caught: Caught;
  over: boolean;
  renderedAt: number | null;
}): Row[] {
  const { run, change, pass, caught, over, renderedAt } = input;
  const rows: Row[] = [];
  rows.push(
    run.state === 'ok'
      ? {
          id: 'run',
          title: 'POST /api/v1/passes',
          line: callLine(run),
          state: 'done',
          at: run.at,
        }
      : run.state === 'fail'
        ? {
            id: 'run',
            title: 'POST /api/v1/passes',
            line: `${run.problem.status || 'No answer'}${run.problem.code ? ` · ${run.problem.code}` : ''}`,
            state: 'fail',
            at: run.at,
          }
        : {
            id: 'run',
            title: 'POST /api/v1/passes',
            line: run.state === 'running' ? 'Sending' : 'Not sent yet',
            state: 'wait',
          },
  );
  const issued = caught['pass.issued'];
  rows.push({
    id: 'issued',
    title: 'pass.issued',
    line: issued
      ? H.issued
      : !pass
        ? H.issued
        : over
          ? H.notYet
          : 'Listening on your test endpoint',
    state: issued ? 'done' : over && pass ? 'skip' : 'wait',
    ...(issued ? { at: issued } : {}),
  });
  rows.push({
    id: 'rendered',
    title: H.rendered,
    line: H.renderedLine,
    state: renderedAt ? 'done' : 'wait',
    ...(renderedAt ? { at: renderedAt } : {}),
  });
  if (change.state === 'ok' || change.state === 'fail' || change.state === 'running') {
    rows.push(
      change.state === 'ok'
        ? {
            id: 'patch',
            title: 'PATCH /api/v1/passes/{id}',
            line: callLine(change),
            state: 'done',
            at: change.at,
          }
        : change.state === 'fail'
          ? {
              id: 'patch',
              title: 'PATCH /api/v1/passes/{id}',
              line: `${change.problem.status || 'No answer'}${change.problem.code ? ` · ${change.problem.code}` : ''}`,
              state: 'fail',
              at: change.at,
            }
          : { id: 'patch', title: 'PATCH /api/v1/passes/{id}', line: 'Sending', state: 'wait' },
    );
    if (change.state === 'ok') {
      const updated = caught['pass.updated'];
      rows.push({
        id: 'updated',
        title: 'pass.updated',
        line: updated ? H.updated : over ? H.notYet : 'Listening on your test endpoint',
        state: updated ? 'done' : over ? 'skip' : 'wait',
        ...(updated ? { at: updated } : {}),
      });
    }
  }
  return rows;
}

export function Timeline({ rows }: { rows: Row[] }) {
  return (
    <section className="card qs-happened" aria-label={H.title}>
      <div className="card-h">
        <h3 className="h3">{H.title}</h3>
        <a className="xs" href={PATHS.webhooks}>
          {H.tester}
        </a>
      </div>
      <ol className="qs-tl">
        {rows.map((r) => (
          <li key={r.id} data-state={r.state}>
            <span className="qs-tl-dot" aria-hidden="true">
              {r.state === 'done' ? (
                <Check className="lucide" />
              ) : r.state === 'fail' ? (
                <X className="lucide" />
              ) : r.state === 'skip' ? (
                <Minus className="lucide" />
              ) : null}
            </span>
            <span className="qs-tl-t">
              <span className="mono sm">{r.title}</span>
              <span className="xs muted">
                <span className="sr">
                  {r.state === 'wait' ? 'Waiting: ' : r.state === 'fail' ? 'Failed: ' : ''}
                </span>
                {r.line}
              </span>
            </span>
            {r.at ? (
              <time className="mono xs muted" dateTime={new Date(r.at).toISOString()}>
                {formatTime(r.at)}
              </time>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
