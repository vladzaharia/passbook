import { DEV_COPY, DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { operations, shortDate } from '../model/dates.ts';
import { pagePath } from '../model/markdown.ts';
import type { ErrorEntry, Site } from '../model/types.ts';
import { MethodPill } from '../ui/method-pill.tsx';

export function Head({ eyebrow, title, line }: { eyebrow?: string; title: string; line?: string }) {
  return (
    <>
      {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
      <h1 className="h1 page-h">{title}</h1>
      {line ? <p className="lede muted mt2 prose">{line}</p> : null}
    </>
  );
}

export function ReferenceIndex({ site }: { site: Site }) {
  return (
    <>
      <Head title={DEV_COPY.reference.title} line={DEV_COPY.reference.lede} />
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
            <span className="xs muted">Codes and their fixes</span>
          </a>
          <a className="card link tile slim" href={PATHS.console}>
            <div className="h3">Console</div>
            <span className="xs muted">Run any operation in your sandbox</span>
          </a>
          <a className="card link tile slim" href={PATHS.protocols}>
            <div className="h3">Protocols</div>
            <span className="xs muted">Apple, scanner and public routes</span>
          </a>
        </div>
      </section>
    </>
  );
}

export function ErrorsIndex({ site }: { site: Site }) {
  return (
    <>
      <Head
        eyebrow="Reference"
        title="Errors"
        line="Every error is problem+json with a stable code. Branch on code, not on the message."
      />
      {site.errors.length === 0 ? (
        <p className="muted mt8">
          The catalog is empty. Each operation lists its codes once they are published.
        </p>
      ) : (
        <div className="table-wrap mt8">
          <table className="errs">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Status</th>
                <th scope="col">Fix</th>
              </tr>
            </thead>
            <tbody>
              {site.errors.map((e) => (
                <tr key={e.code}>
                  <td className="mono">
                    <a href={`${PATHS.errors}/${e.code}`}>{e.code}</a>
                  </td>
                  <td className="mono">{e.status ?? ''}</td>
                  <td>{e.fix || e.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
        {entry.status ? <span className="pill neutral mono">{entry.status}</span> : null}
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
              <a
                key={`${u.slug}${u.anchor}`}
                className="lrow"
                href={`${PATHS.reference}/${u.slug}#${u.anchor}`}
              >
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
      <Head
        eyebrow="Reference"
        title="Protocols"
        line="Routes that devices and wallets call, not integrations: the Apple Wallet web service, the scanner device protocol and public capability links. They are listed so nothing is hidden."
      />
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
    <>
      <Head
        title="Webhooks"
        line="Signed events, one POST per delivery. Verify x-passbook-signature over the raw body, and dedupe on x-passbook-event-id."
      />
      <h2 className="h2 mt8">Events</h2>
      <div className="list card mt4">
        {site.webhookEvents.map((e) => (
          <div key={e.type} className="lrow wrap-row">
            <code className="mono sm strong">{e.type}</code>
            <span className="push muted sm">{e.summary}</span>
          </div>
        ))}
      </div>
      <p className="mt6 muted">
        Endpoints are managed with the{' '}
        <a href={`${PATHS.reference}/webhook-endpoints`}>webhook endpoints</a> API.
      </p>
    </>
  );
}

export function SlotView({ which }: { which: 'quickstart' | 'playground' | 'guides' }) {
  const s = DEV_COPY.slots[which];
  return (
    <>
      <Head title={s.title} line={s.line} />
      {which === 'guides' ? (
        <div className="recipes mt8">
          {DEV_GUIDES.map((g) => (
            <div key={g.id} id={g.id} className="row g3 card tile-row">
              <span className={`sw ${g.tone}`} />
              <span>
                <span className="strong">{g.title}</span>
                <br />
                <span className="xs muted">{g.line}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <p className="mt8">
        <a className="btn outline" href={PATHS.reference}>
          {DEV_COPY.home.reference}
        </a>
      </p>
    </>
  );
}

export function ChangelogView({ site }: { site: Site }) {
  return (
    <>
      <Head
        title="Changelog"
        line="Changes to the API, newest first. The API changes only additively."
      />
      <div className="list card mt8">
        {site.changelog.length === 0 ? <p className="lrow muted">No entries yet.</p> : null}
        {site.changelog.map((c) => (
          <div key={`${c.date}${c.text}`} className="lrow">
            <span className={`pill ${c.kind === 'Added' ? 'accent' : 'neutral'}`}>{c.kind}</span>
            <span className="sm">{c.text}</span>
            <time className="push xs muted nowrap" dateTime={c.date}>
              {shortDate(c.date)}
            </time>
          </div>
        ))}
      </div>
    </>
  );
}
