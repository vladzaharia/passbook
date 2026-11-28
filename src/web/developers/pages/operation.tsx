import { ArrowUpRight } from 'lucide-react';
import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { wbHref } from '../../../shared/workbench.ts';
import { cliSample } from '../model/cli.ts';
import { opPath } from '../model/markdown.ts';
import { exampleSamples, samplesFor } from '../model/samples.ts';
import type { ErrorRow, Field, OpView, ResourcePage, Site } from '../model/types.ts';
import { CopyButton, JsonBlock, SampleTabs } from '../ui/code.tsx';
import { EnvChip } from '../ui/env-chip.tsx';
import { MethodPill } from '../ui/method-pill.tsx';
import { Prose } from '../ui/prose.tsx';
import { Ticket } from '../ui/ticket.tsx';

const WHERE_LABEL: Record<Field['where'], string> = {
  path: 'Path',
  query: 'Query',
  header: 'Headers',
  body: DEV_COPY.reference.body,
};
const WHERE_ORDER: Field['where'][] = ['path', 'query', 'header', 'body'];

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

/** Shown first: what the request's shape decides, before the codes of the resource's module. */
const COMMON = [
  'UNAUTHENTICATED',
  'API_KEY_MISSING',
  'INVALID_API_KEY',
  'MISSING_SCOPE',
  'FORBIDDEN',
  'VALIDATION',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_KEY_INVALID',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
];
const SHOWN = 16;

function ErrorTable({ rows, known }: { rows: ErrorRow[]; known: Set<string> }) {
  return (
    <div className="table-wrap mt4">
      <table className="errs">
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Status</th>
            <th scope="col">Fix</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.code}>
              <td className="mono">
                {known.has(e.code) ? <a href={`${PATHS.errors}/${e.code}`}>{e.code}</a> : e.code}
              </td>
              <td className="mono">{e.statusText ?? e.status ?? ''}</td>
              <td>{e.fix}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The operation's codes with their status and fix, the common ones first; the full catalog is one link away. */
function OpErrors({ op, site }: { op: OpView; site: Site }) {
  if (op.errors.length === 0) return null;
  const known = new Set(site.errors.map((e) => e.code));
  const rank = (c: string) => (COMMON.includes(c) ? COMMON.indexOf(c) : COMMON.length);
  const rows = [...op.errors].sort((a, b) => rank(a.code) - rank(b.code));
  return (
    <section className="page-errors" id="errors">
      <div className="row g3 wrap-row">
        <h2 className="h2">{DEV_COPY.reference.errors}</h2>
        <a className="push sm" href={PATHS.errors}>
          {DEV_COPY.reference.allCodes(site.errors.length)}
        </a>
      </div>
      <ErrorTable rows={rows.slice(0, SHOWN)} known={known} />
      {rows.length > SHOWN ? (
        <details className="op-errors mt4">
          <summary>{rows.length - SHOWN} more codes</summary>
          <ErrorTable rows={rows.slice(SHOWN)} known={known} />
        </details>
      ) : null}
    </section>
  );
}

/** Opens the Console on the operation's own sample; the body is never in the URL. */
const runHref = (op: OpView) => wbHref('console', { query: { op: op.operationId } });

/** The right pane: the request (curl first) as a ticket stub, a signed-out run slot, then the response. */
function Rail({ op, site }: { op: OpView; site: Site }) {
  const samples = [...samplesFor(op, site.baseUrl), ...cliSample(op)];
  const ok = op.returns;
  return (
    <aside className="rail-pane" aria-label={`${op.title}: request and response`}>
      <div className="row g3 rail-h">
        <h2 className="h2">{DEV_COPY.reference.request}</h2>
        <span className="pill info mono">test</span>
      </div>
      <Ticket
        stub={<SampleTabs id={`s-${op.anchor}`} samples={samples} name={op.title} />}
        body={
          <div className="try-foot">
            <a className="btn" href={runHref(op)}>
              {DEV_COPY.reference.tryIt}
              <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
        }
      />
      {op.examples.length > 0 ? (
        <div className="examples">
          <h3 className="h3">{DEV_COPY.reference.examples}</h3>
          {op.examples.map((e) => (
            <details key={e.id} className="example">
              <summary>{e.title}</summary>
              <SampleTabs
                id={`e-${op.anchor}-${e.id}`}
                samples={exampleSamples(e)}
                name={`Example: ${e.title}`}
              />
            </details>
          ))}
        </div>
      ) : null}
      {ok && ok.example !== undefined ? (
        <div className="resp">
          <div className="row g2 resp-h">
            <h3 className="h3">Response</h3>
            <span className="pill success mono">{ok.status}</span>
          </div>
          <JsonBlock json={ok.example} label={`${op.title}: ${ok.status} response`} />
        </div>
      ) : null}
    </aside>
  );
}

/** Previous and next operation in the resource, in the sidebar's order. */
function Neighbours({ page, op }: { page: ResourcePage; op: OpView }) {
  const i = page.ops.indexOf(op);
  const prev = page.ops[i - 1];
  const next = page.ops[i + 1];
  if (!prev && !next) return null;
  return (
    <nav className="op-next row g3 wrap-row mt8" aria-label="Operations">
      {prev ? (
        <a className="btn outline sm" rel="prev" href={opPath(page, prev)}>
          {prev.title}
        </a>
      ) : null}
      {next ? (
        <a className="btn outline sm push" rel="next" href={opPath(page, next)}>
          {next.title}
        </a>
      ) : null}
    </nav>
  );
}

export function OperationView({ page, op, site }: { page: ResourcePage; op: OpView; site: Site }) {
  const groups = WHERE_ORDER.map((w) => ({
    w,
    fields: op.fields.filter((f) => f.where === w),
  })).filter((g) => g.fields.length > 0);
  return (
    <>
      <div className="eyebrow">
        <a href={PATHS.reference}>Reference</a>
        <span aria-hidden="true">·</span>
        <a href={`${PATHS.reference}/${page.slug}`}>{page.label}</a>
      </div>
      {/* The personalizing island: it has no size, and mounts when the page loads. */}
      <i data-island="snippets" aria-hidden="true" />
      <section className="op" aria-labelledby={op.anchor}>
        <i id={op.operationId} className="alias" aria-hidden="true" />
        <div className="op-prose">
          <div className="row g3 wrap-row">
            <h1 className="h1 page-h" id={op.anchor}>
              {op.title}
            </h1>
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
          {op.description ? (
            <p className="lede">
              <Prose text={op.description} />
            </p>
          ) : null}
          <p className="muted sm mt2 meta-links">
            Send <code className="inline-code">Authorization: Bearer</code> <EnvChip />.{' '}
            <a href={`${opPath(page, op)}.md`}>Markdown</a>
          </p>
          {groups.map((g) => (
            <div key={g.w}>
              <h2 className="h2 mt8" id={`params-${g.w}`}>
                {WHERE_LABEL[g.w]}
              </h2>
              <Params fields={g.fields} />
            </div>
          ))}
          {op.returns ? (
            <>
              <h2 className="h2 mt8" id="returns">
                {DEV_COPY.reference.returns}
              </h2>
              <p className="mt2">
                <span className="pill success mono">{op.returns.status}</span>{' '}
                {op.returns.schema ? (
                  <span className="inline-code">{op.returns.schema}</span>
                ) : null}
              </p>
            </>
          ) : null}
          <OpErrors op={op} site={site} />
          <Neighbours page={page} op={op} />
        </div>
        <Rail op={op} site={site} />
      </section>
      <div className="trybar">
        <span className="trybar-op mono">
          <MethodPill method={op.method} />
          <span className="trybar-path">{op.path.replace(/^\/api\/v1/, '')}</span>
        </span>
        <a className="btn" href={runHref(op)}>
          {DEV_COPY.reference.tryIt}
          <ArrowUpRight aria-hidden="true" />
        </a>
      </div>
    </>
  );
}
