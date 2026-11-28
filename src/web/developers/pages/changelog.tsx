import { Rss } from 'lucide-react';
import { PATHS } from '../../../shared/developers.ts';
import { shortDate } from '../model/dates.ts';
import type { ChangeEntry, Site } from '../model/types.ts';

const KINDS = ['All', 'Added', 'Changed', 'Fixed', 'Breaking'] as const;

function days(entries: ChangeEntry[]): [string, ChangeEntry[]][] {
  const out = new Map<string, ChangeEntry[]>();
  for (const e of entries) out.set(e.date, [...(out.get(e.date) ?? []), e]);
  return [...out];
}

/** Kind filters work without script (radio + :has); the area filter is a select that shell/filter.ts reveals. */
export function ChangelogView({ site }: { site: Site }) {
  const areas = [...new Set(site.changelog.map((e) => e.area))].sort();
  return (
    <>
      <div className="row g3 wrap-row between">
        <h1 className="h1 page-h">Changelog</h1>
        <a className="btn ghost sm" href={PATHS.changelogFeed}>
          <Rss aria-hidden="true" />
          Atom feed
        </a>
      </div>
      <p className="lede muted mt2 prose">
        Send <code>PassBook-Version</code> to opt in to a dated version; without it nothing changes.
      </p>
      {site.versions.map((v) => (
        <div key={v.date} className="card cl-version mt4" id={`version-${v.date}`}>
          <div className="row g3 wrap-row">
            <span className="pill accent mono">PassBook-Version: {v.date}</span>
            <span className="sm">{v.summary}</span>
          </div>
          <details className="mt2">
            <summary className="sm">Migration</summary>
            <p className="sm muted mt2">{v.migration}</p>
          </details>
        </div>
      ))}
      <div className="cl" data-changelog>
        <div className="cl-filters mt8" role="radiogroup" aria-label="Filter by kind">
          {KINDS.map((k) => (
            <span key={k}>
              <input type="radio" name="kind" id={`k-${k}`} defaultChecked={k === 'All'} />
              <label htmlFor={`k-${k}`}>{k}</label>
            </span>
          ))}
          <select className="cl-area" data-area-filter aria-label="Filter by resource" hidden>
            <option value="">All resources</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {site.changelog.length === 0 ? <p className="muted mt4">No entries yet.</p> : null}
        {days(site.changelog).map(([date, entries]) => (
          <section key={date} className="cl-day mt6" id={date}>
            <h2 className="h3">
              <time dateTime={date}>{shortDate(date)}</time>
              <span className="muted xs"> {date}</span>
            </h2>
            <div className="list card mt2">
              {entries.map((e) => (
                <div
                  key={e.text}
                  className="lrow cl-item"
                  data-kind={e.kind}
                  data-breaking={e.breaking ? '1' : undefined}
                  data-area={e.area}
                >
                  <span className={`pill ${e.kind === 'Added' ? 'accent' : 'neutral'}`}>
                    {e.kind}
                  </span>
                  {e.breaking ? <span className="pill warn">Breaking</span> : null}
                  <span className="sm cl-text">{e.text}</span>
                  <span className="push xs muted nowrap">{e.area}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
