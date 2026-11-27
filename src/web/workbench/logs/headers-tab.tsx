import type { RequestLogDetail } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';

const C = LOGS_BENCH_COPY.inspector;

function List({ title, items }: { title: string; items: Record<string, string> }) {
  const rows = Object.entries(items);
  if (rows.length === 0) return null;
  return (
    <section className="logs-hdrs">
      <h3 className="logs-hdrs-t">{title}</h3>
      <dl className="logs-hdrs-l">
        {rows.map(([name, value]) => (
          <div key={name} className="logs-hdrs-r">
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The allowlisted headers the call carried and answered with; one quiet line for a row from before they were kept. */
export function HeadersTab({ headers }: { headers: RequestLogDetail['headers'] }) {
  const none = !headers || Object.keys(headers.req).length + Object.keys(headers.res).length === 0;
  if (none) return <p className="logs-quiet">{C.noHeaders}</p>;
  return (
    <div className="logs-hdrs-w">
      <List title={C.request} items={headers.req} />
      <List title={C.response} items={headers.res} />
    </div>
  );
}
