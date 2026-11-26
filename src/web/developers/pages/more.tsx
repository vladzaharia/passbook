import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { opUrl, PATHS } from '../../../shared/developers.ts';
import { operations } from '../model/dates.ts';
import { pagePath } from '../model/markdown.ts';
import type { ErrorEntry, Site } from '../model/types.ts';
import { Gate } from '../ui/gate.tsx';
import { MethodPill } from '../ui/method-pill.tsx';

export function Head({ title, line }: { title: string; line?: string }) {
  return (
    <>
      <h1 className="h1 page-h">{title}</h1>
      {line ? <p className="lede muted mt2 prose">{line}</p> : null}
    </>
  );
}

export function ReferenceIndex({ site }: { site: Site }) {
  return (
    <>
      <Head title={DEV_COPY.reference.title} />
      {site.groups.map((g) => (
        <section key={g.label} className="mt8">
          <h2 className="h2">{g.label}</h2>
          <div className="tiles mt4">
            {g.pages.map((p) => (
              <a key={p.slug} className="card link tile slim" href={pagePath(p)}>
                <div className="h3">{p.label}</div>
                <span className="xs muted">{operations(p.ops.length)}</span>
              </a>
            ))}
          </div>
        </section>
      ))}
      <section className="mt8">
        <h2 className="h2">More</h2>
        <div className="tiles mt4">
          <a className="card link tile slim" href={PATHS.errors}>
            <div className="h3">Errors</div>
          </a>
          <a className="card link tile slim" href={PATHS.console}>
            <div className="h3">Console</div>
          </a>
          <a className="card link tile slim" href={PATHS.protocols}>
            <div className="h3">Protocols</div>
          </a>
        </div>
      </section>
    </>
  );
}

/** The catalog is long: a group per first letter, each closed until opened. */
function errorGroups(errors: Site['errors']): { letter: string; items: Site['errors'] }[] {
  const groups: { letter: string; items: Site['errors'] }[] = [];
  for (const e of errors) {
    const letter = e.code.charAt(0).toUpperCase();
    const last = groups[groups.length - 1];
    if (last && last.letter === letter) last.items.push(e);
    else groups.push({ letter, items: [e] });
  }
  return groups;
}

export function ErrorsIndex({ site }: { site: Site }) {
  return (
    <>
      <Head title="Errors" line="Branch on code, not on the message." />
      {site.errors.length === 0 ? (
        <p className="muted mt8">
          The catalog is empty. Each operation lists its codes once they are published.
        </p>
      ) : (
        <div className="mt8">
          {errorGroups(site.errors).map((g) => (
            <details key={g.letter} className="errs-group" id={`errors-${g.letter}`}>
              <summary>
                <span className="strong">{g.letter}</span>
                <span className="muted sm">{g.items.length}</span>
              </summary>
              <div className="table-wrap">
                <table className="errs">
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Status</th>
                      <th scope="col">Fix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((e) => (
                      <tr key={e.code}>
                        <td className="mono">
                          <a href={`${PATHS.errors}/${e.code}`}>{e.code}</a>
                        </td>
                        <td className="mono">{e.statusText ?? e.status ?? ''}</td>
                        <td>{e.fix || e.title}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

export function ErrorEntryView({ entry }: { entry: ErrorEntry }) {
  return (
    <>
      <div className="eyebrow">
        <a href={PATHS.errors}>Errors</a>
        {entry.status ? (
          <span className="pill neutral mono">{entry.statusText ?? entry.status}</span>
        ) : null}
        {entry.retryable === null ? null : (
          <span className="pill neutral">{entry.retryable ? 'Retry' : 'Do not retry'}</span>
        )}
      </div>
      <h1 className="h1 page-h mono">{entry.code}</h1>
      {entry.title !== entry.code ? <p className="lede mt2 prose">{entry.title}</p> : null}
      {entry.fix ? (
        <>
          <h2 className="h2 mt8">Fix</h2>
          <p className="mt2 prose">{entry.fix}</p>
        </>
      ) : null}
      {entry.when ? (
        <>
          <h2 className="h2 mt8">When</h2>
          <p className="mt2 prose">{entry.when}</p>
        </>
      ) : null}
      {entry.usedBy.length > 0 ? (
        <>
          <h2 className="h2 mt8">Returned by</h2>
          <div className="list card mt4">
            {entry.usedBy.map((u) => (
              <a key={`${u.slug}${u.anchor}`} className="lrow" href={opUrl(u.slug, u.anchor)}>
                {u.title}
              </a>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

export function ProtocolsView({ site }: { site: Site }) {
  return (
    <>
      <Head title="Protocols" line="Called by devices and wallets, not by integrations." />
      <div className="list card mt8">
        {site.protocols.map((p) => (
          <div key={`${p.method}${p.path}`} className="lrow wrap-row">
            <MethodPill method={p.method} />
            <code className="mono sm">{p.path}</code>
            <span className="push muted sm">{p.reason || p.title}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function WebhooksView({ site }: { site: Site }) {
  return (
    <div className="wh">
      <div
        className="stack g4"
        data-island="webhook-tester"
        data-types={site.webhookEvents.map((e) => e.type).join(',')}
      >
        <Gate
          title={GATE_COPY.lines.webhooks}
          next={PATHS.webhooks}
          docs={`${PATHS.reference}/webhook-endpoints`}
        />
      </div>
      <section>
        <h2 className="h2">Events</h2>
        <p className="muted mt2 prose">
          Signed events, one POST per delivery. Verify x-passbook-signature over the raw body, and
          dedupe on x-passbook-event-id.
        </p>
        <div className="list card mt4">
          {site.webhookEvents.map((e) => (
            <div key={e.type} id={e.type} className="lrow wrap-row">
              <code className="mono sm strong">{e.type}</code>
              <span className="push muted sm">{e.summary}</span>
            </div>
          ))}
        </div>
        <p className="mt6 muted">
          Endpoints are managed with the{' '}
          <a href={`${PATHS.reference}/webhook-endpoints`}>webhook endpoints</a> API.
        </p>
      </section>
    </div>
  );
}
