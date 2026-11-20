import { ArrowUpRight } from 'lucide-react';
import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { operations } from '../model/dates.ts';
import { samplesFor } from '../model/samples.ts';
import type { ConsoleOp, Field, OpView, ResourcePage, Site } from '../model/types.ts';
import { CopyButton, JsonBlock, SampleTabs } from '../ui/code.tsx';
import { EnvChip } from '../ui/env-chip.tsx';
import { MethodPill } from '../ui/method-pill.tsx';
import { Prose } from '../ui/prose.tsx';
import { Ticket } from '../ui/ticket.tsx';
import { SIGN_IN } from './layout.tsx';

const WHERE_LABEL: Record<Field['where'], string> = {
  path: 'Path',
  query: 'Query',
  header: 'Headers',
  body: DEV_COPY.reference.body,
};
const WHERE_ORDER: Field['where'][] = ['path', 'query', 'header', 'body'];

const humanize = (sub: string) =>
  sub
    .replace(/([A-Z])/g, ' $1')
    .replace(/-/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

function Params({ fields }: { fields: Field[] }) {
  return (
    <div className="params">
      {fields.map((f) => (
        <div key={f.name}>
          <div className="row g2 wrap-row">
            <span className="pn">{f.name}</span>
            <span className="pt">{f.type}</span>
            {f.required ? <span className="req">Required</span> : null}
            {f.deprecated ? <span className="pill neutral">Deprecated</span> : null}
          </div>
          {f.description ? (
            <p className="pd">
              <Prose text={f.description} />
            </p>
          ) : null}
          {f.children.length > 0 ? (
            <div className="kids">
              <Params fields={f.children} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ErrorsTable({ op, known }: { op: OpView; known: Set<string> }) {
  if (op.errors.length === 0) return null;
  return (
    <>
      <h3 className="h2 mt8">{DEV_COPY.reference.errors}</h3>
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
            {op.errors.map((e) => (
              <tr key={e.code}>
                <td className="mono">
                  {known.has(e.code) ? <a href={`${PATHS.errors}/${e.code}`}>{e.code}</a> : e.code}
                </td>
                <td className="mono">{e.status ?? ''}</td>
                <td>{e.fix}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The right pane: the request as a ticket stub, a signed-out run slot, then the response. */
function Rail({ op, site, slot }: { op: OpView; site: Site; slot: string }) {
  const samples = samplesFor(op, site.baseUrl);
  const ok = op.returns;
  return (
    <aside className="rail-pane" aria-label={`${op.title}: request and response`}>
      <div className="row g3 rail-h">
        <h3 className="h2">{DEV_COPY.reference.tryIt}</h3>
        <span className="pill info mono">test</span>
      </div>
      <div id={slot} data-island="run" data-op={op.operationId} className="try">
        <Ticket
          stub={<SampleTabs id={`s-${op.anchor}`} samples={samples} />}
          body={
            <div className="row g3 try-foot">
              <a className="btn sm" href={SIGN_IN}>
                {DEV_COPY.reference.signInToTry}
              </a>
              <span className="xs muted">{DEV_COPY.reference.tryLine}</span>
            </div>
          }
        />
      </div>
      {op.examples.length > 0 ? (
        <div className="examples">
          <h3 className="h3">{DEV_COPY.reference.examples}</h3>
          {op.examples.map((e) => (
            <details key={e.id} className="example">
              <summary>{e.title}</summary>
              <SampleTabs
                id={`e-${op.anchor}-${e.id}`}
                samples={[
                  ...(e.curl
                    ? [{ lang: 'curl' as const, label: 'curl', file: `${e.id}.sh`, code: e.curl }]
                    : []),
                  { lang: 'ts' as const, label: 'TypeScript', file: `${e.id}.ts`, code: e.ts },
                ]}
              />
            </details>
          ))}
        </div>
      ) : null}
      {ok && ok.example !== undefined ? (
        <div className="resp">
          <div className="row g2 resp-h">
            <span className="h3">Response</span>
            <span className="pill success mono">{ok.status}</span>
            <CopyButton label="Copy response" />
          </div>
          <JsonBlock json={ok.example} label={`${op.title}: ${ok.status} response`} />
        </div>
      ) : null}
    </aside>
  );
}

function Operation({ op, site, known }: { op: OpView; site: Site; known: Set<string> }) {
  const groups = WHERE_ORDER.map((w) => ({
    w,
    fields: op.fields.filter((f) => f.where === w),
  })).filter((g) => g.fields.length > 0);
  return (
    <section className="op" aria-labelledby={op.anchor}>
      <i id={op.operationId} className="alias" aria-hidden="true" />
      <div className="op-prose">
        <div className="row g3 wrap-row">
          <h2 className="h1" id={op.anchor}>
            <a className="anchor" href={`#${op.anchor}`} aria-label={`Link to ${op.title}`}>
              {op.title}
            </a>
          </h2>
          {op.deprecated ? <span className="pill neutral">Deprecated</span> : null}
          {op.changedIn ? (
            <a
              className={`pill changed-in ${op.changedIn.breaking ? 'warn' : 'neutral'}`}
              href={`${PATHS.changelog}#${op.changedIn.date}`}
            >
              {op.changedIn.kind === 'Added' ? 'New in' : 'Changed in'} {op.changedIn.date}
            </a>
          ) : null}
        </div>
        <div className="endpoint row g3">
          <MethodPill method={op.method} />
          <code>{op.path}</code>
          <CopyButton label="Copy path" />
        </div>
        {op.description ? (
          <p className="lede">
            <Prose text={op.description} />
          </p>
        ) : null}
        <div className="wrap-row g2 chips">
          {op.scopes.map((s) => (
            <span key={s} className="chip mono">
              {s}
            </span>
          ))}
          {op.idempotent ? <span className="chip">Idempotent with key</span> : null}
          <span className="chip mono">
            {DEV_COPY.reference.sdk} {op.sdkCall}
          </span>
        </div>
        {groups.map((g) => (
          <div key={g.w}>
            <h3 className="h2 mt8">{WHERE_LABEL[g.w]}</h3>
            <Params fields={g.fields} />
          </div>
        ))}
        {op.returns ? (
          <>
            <h3 className="h2 mt8">{DEV_COPY.reference.returns}</h3>
            <p className="mt2">
              <span className="pill success mono">{op.returns.status}</span>{' '}
              {op.returns.schema ? <span className="inline-code">{op.returns.schema}</span> : null}
            </p>
          </>
        ) : null}
        <ErrorsTable op={op} known={known} />
      </div>
      <Rail op={op} site={site} slot={`try-${op.anchor}`} />
    </section>
  );
}

function ConsoleOnly({ ops }: { ops: ConsoleOp[] }) {
  if (ops.length === 0) return null;
  return (
    <section className="console-only">
      <h2 className="h2">{DEV_COPY.reference.consoleOnly}</h2>
      <p className="muted">{DEV_COPY.reference.consoleOnlyLine}</p>
      <div className="list card mt4">
        {ops.map((o) => (
          <div key={`${o.method}${o.path}`} className="lrow">
            <MethodPill method={o.method} />
            <code className="mono sm">{o.path}</code>
            <span className="push muted sm">{o.title}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ResourceView({ page, site }: { page: ResourcePage; site: Site }) {
  const known = new Set(site.errors.map((e) => e.code));
  let sub: string | null | undefined;
  const first = page.ops[0];
  return (
    <>
      <div className="eyebrow">
        <a href={PATHS.reference}>Reference</a>
        <span aria-hidden="true">·</span>
        <span>{page.group}</span>
      </div>
      {/* The personalizing island: it has no size, and mounts when the page loads. */}
      <i data-island="snippets" aria-hidden="true" />
      <h1 className="h1 page-h">{page.label}</h1>
      <p className="muted mt2">
        {operations(page.ops.length)}. Send{' '}
        <code className="inline-code">Authorization: Bearer</code> <EnvChip />.{' '}
        <a href={`${PATHS.reference}/${page.slug}.md`}>Markdown</a>
      </p>
      {page.ops.map((op) => {
        const heading = op.sub !== sub && op.sub ? humanize(op.sub) : null;
        sub = op.sub;
        return (
          <div key={op.anchor}>
            {heading ? <h2 className="sub-h">{heading}</h2> : null}
            <Operation op={op} site={site} known={known} />
          </div>
        );
      })}
      <ConsoleOnly ops={page.consoleOnly} />
      {first ? (
        <div className="trybar" data-island="try-bar">
          <a className="btn" href={`#try-${first.anchor}`} data-try-bar>
            {DEV_COPY.reference.tryIt}
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      ) : null}
    </>
  );
}
